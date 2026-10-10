/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

#include <node_api.h>
#include "bgra-capture.h"
#include <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <chrono>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" AXError _AXUIElementGetWindow(AXUIElementRef element, CGWindowID *window);

namespace {
constexpr size_t MAX_LEASES = 64;
constexpr size_t MAX_CAPTURES = 4;
constexpr CFIndex MAX_WINDOWS = 128;
constexpr float AX_TIMEOUT_SECONDS = 0.1f;
constexpr auto WALK_BUDGET = std::chrono::milliseconds(250);
using Deadline = std::chrono::steady_clock::time_point;

template <typename Read>
AXError readAX(Deadline deadline, Read read) {
  if (std::chrono::steady_clock::now() >= deadline) return kAXErrorCannotComplete;
  auto error = read();
  // A busy target can time out while the retained window is still valid.
  // Retry only that transport error, with room for the existing read timeout.
  const auto readTimeout = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
      std::chrono::duration<float>(AX_TIMEOUT_SECONDS));
  if (error == kAXErrorCannotComplete &&
      std::chrono::steady_clock::now() + readTimeout < deadline)
    error = read();
  return std::chrono::steady_clock::now() < deadline ? error : kAXErrorCannotComplete;
}

AXError copyAttribute(AXUIElementRef element, CFStringRef attribute,
                      CFTypeRef *value, Deadline deadline) {
  const auto clear = [&] { if (*value) CFRelease(*value); *value = nullptr; };
  const auto error = readAX(deadline, [&] {
    clear();
    return AXUIElementCopyAttributeValue(element, attribute, value);
  });
  if (error != kAXErrorSuccess) clear();
  return error;
}

AXError windowNumber(AXUIElementRef element, CGWindowID *value, Deadline deadline) {
  return readAX(deadline, [&] { *value = 0; return _AXUIElementGetWindow(element, value); });
}

struct ReleaseCF {
  void operator()(const void *value) const { if (value) CFRelease(value); }
};
using OwnedCF = std::unique_ptr<const void, ReleaseCF>;

struct ProcessStart {
  uint64_t seconds;
  uint64_t microseconds;
  bool operator==(const ProcessStart&) const = default;
};

bool processStart(uint32_t pid, ProcessStart &start) {
  proc_bsdinfo info{};
  if (pid == 0 || pid > INT32_MAX ||
      proc_pidinfo(static_cast<int>(pid), PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_pid != pid || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1000000) return false;
  start = {info.pbi_start_tvsec, info.pbi_start_tvusec};
  return true;
}

bool windowOwner(uint32_t pid, uint32_t windowId) {
  OwnedCF info(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowId));
  if (!info) return false;
  const auto rows = static_cast<CFArrayRef>(info.get());
  for (CFIndex i = 0; i < CFArrayGetCount(rows); ++i) {
    auto value = CFArrayGetValueAtIndex(rows, i);
    if (!value || CFGetTypeID(value) != CFDictionaryGetTypeID()) return false;
    auto row = static_cast<CFDictionaryRef>(value);
    auto id = static_cast<CFNumberRef>(CFDictionaryGetValue(row, kCGWindowNumber));
    auto owner = static_cast<CFNumberRef>(CFDictionaryGetValue(row, kCGWindowOwnerPID));
    int64_t foundId = 0, foundPid = 0;
    if (id && owner && CFGetTypeID(id) == CFNumberGetTypeID() && CFGetTypeID(owner) == CFNumberGetTypeID() && CFNumberGetValue(id, kCFNumberSInt64Type, &foundId) &&
        CFNumberGetValue(owner, kCFNumberSInt64Type, &foundPid) &&
        foundId == windowId && foundPid == pid) return true;
  }
  return false;
}

bool ownedWindows(uint32_t pid, std::vector<OwnedCF> &result, Deadline deadline) {
  OwnedCF app(AXUIElementCreateApplication(static_cast<pid_t>(pid)));
  if (!app || AXUIElementSetMessagingTimeout(static_cast<AXUIElementRef>(app.get()), AX_TIMEOUT_SECONDS) != kAXErrorSuccess)
    return false;
  CFTypeRef value = nullptr;
  if (copyAttribute(static_cast<AXUIElementRef>(app.get()), kAXWindowsAttribute, &value, deadline) != kAXErrorSuccess)
    return false;
  OwnedCF windows(value);
  if (!windows || CFGetTypeID(windows.get()) != CFArrayGetTypeID()) return false;
  size_t examined = 0;
  std::function<bool(CFArrayRef, unsigned, bool)> walk = [&](CFArrayRef rows, unsigned depth, bool sheetsOnly) {
    const auto count = CFArrayGetCount(rows);
    if (count > MAX_WINDOWS || examined + count > MAX_WINDOWS) return false;
    for (CFIndex i = 0; i < count; ++i) {
      if (std::chrono::steady_clock::now() >= deadline) return false;
      ++examined;
      auto candidate = static_cast<AXUIElementRef>(CFArrayGetValueAtIndex(rows, i));
      if (!candidate || CFGetTypeID(candidate) != AXUIElementGetTypeID()) continue;
      if (AXUIElementSetMessagingTimeout(candidate, AX_TIMEOUT_SECONDS) != kAXErrorSuccess) return false;
      CFTypeRef roleValue = nullptr;
      if (copyAttribute(candidate, kAXRoleAttribute, &roleValue, deadline) != kAXErrorSuccess) continue;
      OwnedCF role(roleValue);
      if (!role || (sheetsOnly ? !CFEqual(role.get(), kAXSheetRole)
          : !CFEqual(role.get(), kAXSheetRole) && !CFEqual(role.get(), kAXWindowRole))) continue;
      bool seen = false;
      for (const auto &item : result) if (CFEqual(item.get(), candidate)) { seen = true; break; }
      if (seen) continue;
      result.emplace_back(CFRetain(candidate));
      if (depth >= 3) continue;
      // AppKit can expose a sheet only through AXChildren, while AXSheets is
      // absent. Only sheet roles enter discovery; controls remain excluded.
      for (CFStringRef attribute : {CFSTR("AXSheets"), kAXChildrenAttribute}) {
        CFTypeRef children = nullptr;
        AXError error = copyAttribute(candidate, attribute, &children, deadline);
        OwnedCF sheets(children);
        if (error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue) continue;
        if (error != kAXErrorSuccess) return false;
        if (sheets && CFGetTypeID(sheets.get()) == CFArrayGetTypeID() &&
            !walk(static_cast<CFArrayRef>(sheets.get()), depth + 1, true)) return false;
      }
    }
    return true;
  };
  return walk(static_cast<CFArrayRef>(windows.get()), 0, false) && std::chrono::steady_clock::now() < deadline;
}

OwnedCF exactWindow(uint32_t pid, uint32_t windowId, Deadline deadline) {
  // Ordinary windows can be matched without scanning their controls on every
  // video frame. The bounded sheet walk is needed only for nested windows.
  OwnedCF app(AXUIElementCreateApplication(static_cast<pid_t>(pid)));
  if (!app || AXUIElementSetMessagingTimeout(static_cast<AXUIElementRef>(app.get()), AX_TIMEOUT_SECONDS) != kAXErrorSuccess)
    return {};
  CFTypeRef rootsValue = nullptr;
  if (copyAttribute(static_cast<AXUIElementRef>(app.get()), kAXWindowsAttribute, &rootsValue, deadline) != kAXErrorSuccess)
    return {};
  OwnedCF roots(rootsValue);
  if (!roots || CFGetTypeID(roots.get()) != CFArrayGetTypeID()) return {};
  auto rows = static_cast<CFArrayRef>(roots.get());
  if (CFArrayGetCount(rows) > MAX_WINDOWS) return {};
  AXUIElementRef direct = nullptr;
  for (CFIndex index = 0; index < CFArrayGetCount(rows); ++index) {
    if (std::chrono::steady_clock::now() >= deadline) return {};
    auto candidate = static_cast<AXUIElementRef>(CFArrayGetValueAtIndex(rows, index));
    if (!candidate || CFGetTypeID(candidate) != AXUIElementGetTypeID()) continue;
    if (AXUIElementSetMessagingTimeout(candidate, AX_TIMEOUT_SECONDS) != kAXErrorSuccess) return {};
    CGWindowID found = 0;
    if (windowNumber(candidate, &found, deadline) == kAXErrorSuccess && found == windowId) {
      if (direct) return {};
      direct = candidate;
    }
  }
  if (direct) return std::chrono::steady_clock::now() < deadline ? OwnedCF(CFRetain(direct)) : OwnedCF{};
  std::vector<OwnedCF> windows;
  if (!ownedWindows(pid, windows, deadline)) return {};
  AXUIElementRef matched = nullptr;
  for (const auto &window : windows) {
    auto candidate = static_cast<AXUIElementRef>(window.get());
    CGWindowID found = 0;
    if (windowNumber(candidate, &found, deadline) == kAXErrorSuccess && found == windowId) {
      if (matched) return {}; // Multiple AX destinations cannot identify one window instance.
      matched = candidate;
    }
  }
  if (!matched || std::chrono::steady_clock::now() >= deadline) return {};
  return OwnedCF(CFRetain(matched));
}

struct Lease {
  uint32_t pid;
  uint32_t windowId;
  ProcessStart start;
  OwnedCF window;
  std::atomic<bool> active{true};
  Lease(uint32_t process, uint32_t id, ProcessStart created, OwnedCF element)
      : pid(process), windowId(id), start(created), window(std::move(element)) {}
};

bool valid(const Lease &lease) {
  const auto deadline = std::chrono::steady_clock::now() + WALK_BUDGET;
  if (!lease.active) return false;
  ProcessStart current{};
  if (!processStart(lease.pid, current) || !(current == lease.start) ||
      !windowOwner(lease.pid, lease.windowId)) return false;
  // Retaining the remote AX object distinguishes another window created with
  // the same WindowServer number, including reuse inside the same process.
  CFTypeRef role = nullptr;
  if (copyAttribute(static_cast<AXUIElementRef>(lease.window.get()), kAXRoleAttribute, &role, deadline) != kAXErrorSuccess)
    return false;
  OwnedCF ownedRole(role);
  if (!ownedRole || (!CFEqual(ownedRole.get(), kAXWindowRole) && !CFEqual(ownedRole.get(), kAXSheetRole))) return false;
  auto currentWindow = exactWindow(lease.pid, lease.windowId, deadline);
  return currentWindow && CFEqual(currentWindow.get(), lease.window.get()) &&
         processStart(lease.pid, current) && current == lease.start &&
         windowOwner(lease.pid, lease.windowId) && lease.active &&
         std::chrono::steady_clock::now() < deadline;
}

struct CaptureRecord {
  std::string leaseId;
  std::shared_ptr<maka_preview::Capture> capture;
};
struct Registry {
  std::unordered_map<std::string, std::shared_ptr<Lease>> leases;
  std::unordered_map<std::string, CaptureRecord> captures;
  void release(const std::string &id) {
    auto found = leases.find(id);
    if (found != leases.end()) found->second->active = false;
    for (auto it = captures.begin(); it != captures.end();) {
      if (it->second.leaseId == id) { it->second.capture->stop(); it = captures.erase(it); }
      else ++it;
    }
    leases.erase(id);
  }
  void clear() {
    for (auto &[id, lease] : leases) lease->active = false;
    for (auto &[id, record] : captures) record.capture->stop();
    captures.clear(); leases.clear();
  }
  ~Registry() { clear(); }
};

Registry *registry(napi_env env) {
  void *data = nullptr;
  return napi_get_instance_data(env, &data) == napi_ok ? static_cast<Registry *>(data) : nullptr;
}
napi_value undefined(napi_env env) { napi_value out; napi_get_undefined(env, &out); return out; }
napi_value boolean(napi_env env, bool value) { napi_value out; napi_get_boolean(env, value, &out); return out; }
bool number(napi_env env, napi_value value, uint32_t &out) {
  double input = 0;
  if (napi_get_value_double(env, value, &input) != napi_ok || !std::isfinite(input) || input < 1 || input > UINT32_MAX || std::floor(input) != input) return false;
  out = static_cast<uint32_t>(input); return true;
}
bool token(napi_env env, napi_value value, std::string &out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length != 36) return false;
  char buffer[37]{};
  if (napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) != napi_ok) return false;
  out.assign(buffer, length); return true;
}

std::string uuid() {
  OwnedCF value(CFUUIDCreate(kCFAllocatorDefault));
  if (!value) return {};
  OwnedCF text(CFUUIDCreateString(kCFAllocatorDefault, static_cast<CFUUIDRef>(value.get())));
  char id[37]{};
  if (!text || !CFStringGetCString(static_cast<CFStringRef>(text.get()), id, sizeof(id), kCFStringEncodingUTF8)) return {};
  return id;
}

napi_value acquire(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2]; uint32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 2 ||
      !number(env, args[0], pid) || !number(env, args[1], windowId)) return undefined(env);
  auto store = registry(env);
  if (!store) return undefined(env);
  if (store->leases.size() >= MAX_LEASES) return undefined(env);
  ProcessStart before{}, after{};
  if (!processStart(pid, before) || !windowOwner(pid, windowId)) return undefined(env);
  const auto deadline = std::chrono::steady_clock::now() + WALK_BUDGET;
  auto window = exactWindow(pid, windowId, deadline);
  if (!window || !processStart(pid, after) || !(before == after) || !windowOwner(pid, windowId) ||
      std::chrono::steady_clock::now() >= deadline) return undefined(env);
  const auto id = uuid();
  if (id.empty()) return undefined(env);
  store->leases.emplace(id, std::make_shared<Lease>(pid, windowId, before, std::move(window)));
  napi_value out; napi_create_string_utf8(env, id.c_str(), id.size(), &out); return out;
}

// Drop stale native records when a retained AX object becomes inaccessible.
// Acquisition and validation are read-only; there are no AX action calls.

napi_value validate(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value args[3]; std::string id; uint32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 3 ||
      !token(env, args[0], id) || !number(env, args[1], pid) || !number(env, args[2], windowId)) return boolean(env, false);
  auto store = registry(env);
  if (!store) return boolean(env, false);
  auto found = store->leases.find(id);
  if (found == store->leases.end() || found->second->pid != pid || found->second->windowId != windowId) return boolean(env, false);
  if (valid(*found->second)) return boolean(env, true);
  store->release(id); return boolean(env, false);
}

napi_value applicationIcon(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value args[3]; std::string id; uint32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 3 ||
      !token(env, args[0], id) || !number(env, args[1], pid) || !number(env, args[2], windowId)) return undefined(env);
  auto store = registry(env);
  if (!store) return undefined(env);
  auto found = store->leases.find(id);
  if (found == store->leases.end() || found->second->pid != pid || found->second->windowId != windowId)
    return undefined(env);
  if (!valid(*found->second)) { store->release(id); return undefined(env); }
  @autoreleasepool {
    NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:static_cast<pid_t>(pid)];
    NSURL *url = application.bundleURL;
    if (!url.isFileURL || ![url.pathExtension isEqualToString:@"app"]) return undefined(env);
    NSImage *icon = application.icon ?: [[NSWorkspace sharedWorkspace] iconForFile:url.path];
    if (!icon.isValid) return undefined(env);
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
      pixelsWide:32 pixelsHigh:32 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
      colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:128 bitsPerPixel:32];
    NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    if (!bitmap || !context) return undefined(env);
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:context];
    [icon drawInRect:NSMakeRect(0, 0, 32, 32) fromRect:NSZeroRect operation:NSCompositingOperationCopy
      fraction:1 respectFlipped:NO hints:@{NSImageHintInterpolation: @(NSImageInterpolationHigh)}];
    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png.length || png.length > 64 * 1024) return undefined(env);
    if (!valid(*found->second)) { store->release(id); return undefined(env); }
    napi_value out;
    if (napi_create_buffer_copy(env, png.length, png.bytes, nullptr, &out) != napi_ok) return undefined(env);
    return out;
  }
}

napi_value startCapture(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value args[5]; std::string leaseId; uint32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 5 ||
      !token(env, args[0], leaseId) || !number(env, args[1], pid) || !number(env, args[2], windowId)) return undefined(env);
  napi_valuetype callbackType;
  if (napi_typeof(env, args[4], &callbackType) != napi_ok || callbackType != napi_function) return undefined(env);
  uint32_t width = 0, height = 0, fps = 0;
  napi_value value;
  if (napi_get_named_property(env, args[3], "maxWidth", &value) != napi_ok || !number(env, value, width) ||
      napi_get_named_property(env, args[3], "maxHeight", &value) != napi_ok || !number(env, value, height) ||
      napi_get_named_property(env, args[3], "fps", &value) != napi_ok || !number(env, value, fps) ||
      width > 1920 || height > 1920 || static_cast<uint64_t>(width) * height > 2073600 || fps > 30) return undefined(env);
  auto store = registry(env);
  if (!store || store->captures.size() >= MAX_CAPTURES) return undefined(env);
  auto found = store->leases.find(leaseId);
  if (found == store->leases.end() || found->second->pid != pid || found->second->windowId != windowId) return undefined(env);
  auto lease = found->second;
  if (!valid(*lease)) { store->release(leaseId); return undefined(env); }
  // One capture per lease prevents duplicate producers for the same publication.
  for (const auto &[id, record] : store->captures)
    if (record.leaseId == leaseId) return undefined(env);
  const auto id = uuid();
  if (id.empty()) return undefined(env);
  auto capture = maka_preview::startBGRA(env, {id, leaseId, pid, windowId, width, height, fps},
                                        [lease] { return valid(*lease); }, args[4]);
  if (!capture) return undefined(env);
  store->captures.emplace(id, CaptureRecord{leaseId, std::move(capture)});
  napi_value out; napi_create_string_utf8(env, id.c_str(), id.size(), &out); return out;
}

napi_value stopCapture(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; std::string id;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) == napi_ok && argc == 1 && token(env, args[0], id)) {
    if (auto store = registry(env)) {
      auto found = store->captures.find(id);
      if (found != store->captures.end()) {
        found->second.capture->stop();
        store->captures.erase(found);
      }
    }
  }
  return undefined(env);
}

napi_value listOwnedWindows(napi_env env, napi_callback_info info) {
  napi_value out; napi_create_array(env, &out);
  size_t argc = 1; napi_value args[1]; uint32_t pid = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
      !number(env, args[0], pid)) return out;
  ProcessStart before{}, after{};
  std::vector<OwnedCF> windows;
  const auto deadline = std::chrono::steady_clock::now() + WALK_BUDGET;
  if (!processStart(pid, before) || !ownedWindows(pid, windows, deadline)) return out;
  uint32_t index = 0;
  for (const auto &window : windows) {
    if (std::chrono::steady_clock::now() >= deadline) { napi_create_array(env, &out); return out; }
    auto element = static_cast<AXUIElementRef>(window.get());
    CGWindowID windowId = 0;
    if (windowNumber(element, &windowId, deadline) != kAXErrorSuccess || !windowId || !windowOwner(pid, windowId)) continue;
    CFTypeRef value = nullptr;
    if (copyAttribute(element, kAXRoleAttribute, &value, deadline) != kAXErrorSuccess) continue;
    OwnedCF role(value);
    if (!role || (!CFEqual(role.get(), kAXWindowRole) && !CFEqual(role.get(), kAXSheetRole))) continue;
    OwnedCF information(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowId));
    if (!information || CFArrayGetCount(static_cast<CFArrayRef>(information.get())) != 1) continue;
    auto row = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(static_cast<CFArrayRef>(information.get()), 0));
    auto bounds = static_cast<CFDictionaryRef>(CFDictionaryGetValue(row, kCGWindowBounds));
    CGRect rect{};
    if (!bounds || !CGRectMakeWithDictionaryRepresentation(bounds, &rect)) continue;
    value = nullptr;
    copyAttribute(element, kAXTitleAttribute, &value, deadline);
    OwnedCF title(value);
    char titleText[4096]{};
    if (title && CFGetTypeID(title.get()) == CFStringGetTypeID())
      CFStringGetCString(static_cast<CFStringRef>(title.get()), titleText, sizeof(titleText), kCFStringEncodingUTF8);
    napi_value item, field;
    napi_create_object(env, &item);
    auto setNumber = [&](const char *key, double input) {
      napi_create_double(env, input, &field); napi_set_named_property(env, item, key, field);
    };
    setNumber("pid", pid); setNumber("windowId", windowId);
    setNumber("x", rect.origin.x); setNumber("y", rect.origin.y);
    setNumber("width", rect.size.width); setNumber("height", rect.size.height);
    napi_create_string_utf8(env, titleText, NAPI_AUTO_LENGTH, &field);
    napi_set_named_property(env, item, "title", field);
    napi_create_string_utf8(env, CFEqual(role.get(), kAXSheetRole) ? "AXSheet" : "AXWindow", NAPI_AUTO_LENGTH, &field);
    napi_set_named_property(env, item, "role", field);
    napi_set_element(env, out, index++, item);
  }
  if (!processStart(pid, after) || !(before == after) || std::chrono::steady_clock::now() >= deadline)
    napi_create_array(env, &out);
  return out;
}

napi_value release(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; std::string id;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) == napi_ok && argc == 1 && token(env, args[0], id)) {
    if (auto store = registry(env)) store->release(id);
  }
  return undefined(env);
}
napi_value dispose(napi_env env, napi_callback_info) {
  if (auto store = registry(env)) store->clear();
  return undefined(env);
}
napi_value initialize(napi_env env, napi_value exports) {
  auto store = new Registry();
  napi_set_instance_data(env, store, [](napi_env, void *data, void *) { delete static_cast<Registry *>(data); }, nullptr);
  napi_add_env_cleanup_hook(env, [](void *data) { static_cast<Registry *>(data)->clear(); }, store);
  const napi_property_descriptor methods[] = {
    {"acquire", nullptr, acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"validate", nullptr, validate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"startCapture", nullptr, startCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stopCapture", nullptr, stopCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listOwnedWindows", nullptr, listOwnedWindows, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"applicationIcon", nullptr, applicationIcon, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
