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

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <wincodec.h>
#include <node_api.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
constexpr size_t MAX_LEASES = 64;
constexpr size_t MAX_LISTED_WINDOWS = 128;

bool windowOwner(uint32_t pid, HWND window) {
  DWORD owner = 0;
  return IsWindow(window) && GetWindowThreadProcessId(window, &owner) != 0 && owner == pid;
}

bool processStart(HANDLE process, FILETIME &start) {
  FILETIME exited{}, kernel{}, user{};
  return WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
         GetProcessTimes(process, &start, &exited, &kernel, &user);
}

struct Lease {
  uint32_t pid;
  uint32_t windowId;
  HANDLE process;
  FILETIME start;
  std::wstring property;
  HANDLE marker;

  ~Lease() {
    HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(windowId));
    if (marker && !property.empty() && windowOwner(pid, window) &&
        GetPropW(window, property.c_str()) == marker)
      RemovePropW(window, property.c_str());
    if (process) CloseHandle(process);
  }
};

bool valid(const Lease &lease) {
  FILETIME current{};
  HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(lease.windowId));
  return processStart(lease.process, current) && CompareFileTime(&lease.start, &current) == 0 &&
         windowOwner(lease.pid, window) && GetPropW(window, lease.property.c_str()) == lease.marker &&
         processStart(lease.process, current) && CompareFileTime(&lease.start, &current) == 0;
}

struct Registry { std::unordered_map<std::string, std::unique_ptr<Lease>> leases; };

Registry *registry(napi_env env) {
  void *data = nullptr;
  return napi_get_instance_data(env, &data) == napi_ok ? static_cast<Registry *>(data) : nullptr;
}
napi_value undefined(napi_env env) {
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}
napi_value boolean(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}
bool number(napi_env env, napi_value value, uint32_t &out) {
  double input = 0;
  if (napi_get_value_double(env, value, &input) != napi_ok || !std::isfinite(input) ||
      input < 1 || input > UINT32_MAX || std::floor(input) != input) return false;
  out = static_cast<uint32_t>(input);
  return true;
}
bool token(napi_env env, napi_value value, std::string &out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length != 36)
    return false;
  char buffer[37]{};
  if (napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) != napi_ok)
    return false;
  out.assign(buffer, length);
  return true;
}

napi_value acquire(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  uint32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 2 ||
      !number(env, args[0], pid) || !number(env, args[1], windowId)) return undefined(env);
  auto store = registry(env);
  if (!store || store->leases.size() >= MAX_LEASES) return undefined(env);
  auto lease = std::make_unique<Lease>();
  lease->pid = pid;
  lease->windowId = windowId;
  lease->marker = nullptr;
  lease->process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(windowId));
  if (!lease->process || !processStart(lease->process, lease->start) || !windowOwner(pid, window))
    return undefined(env);

  GUID uuid{}, markerUuid{};
  wchar_t formatted[39]{};
  if (FAILED(CoCreateGuid(&uuid)) || FAILED(CoCreateGuid(&markerUuid)) ||
      StringFromGUID2(uuid, formatted, 39) != 39) return undefined(env);
  std::wstring wideId(formatted + 1, 36);
  std::string id;
  for (wchar_t character : wideId) id.push_back(static_cast<char>(character));
  if (store->leases.contains(id)) return undefined(env);
  uintptr_t marker = 0;
  std::memcpy(&marker, &markerUuid, sizeof(marker));
  if (!marker) return undefined(env);
  lease->marker = reinterpret_cast<HANDLE>(marker);
  lease->property = L"Maka.ComputerUse.WindowIdentity." + wideId;

  // User32 removes properties when a window is destroyed. A replacement HWND,
  // including one owned by the same process, cannot inherit this random marker.
  // UIPI or inaccessible windows fail closed; no input or focus operation occurs.
  if (GetPropW(window, lease->property.c_str()) != nullptr ||
      !SetPropW(window, lease->property.c_str(), lease->marker) || !valid(*lease))
    return undefined(env);
  store->leases.emplace(id, std::move(lease));
  napi_value out;
  napi_create_string_utf8(env, id.c_str(), id.size(), &out);
  return out;
}

napi_value validateLease(napi_env env, napi_callback_info info, bool requireForeground) {
  size_t argc = 3;
  napi_value args[3];
  std::string id;
  uint32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 3 ||
      !token(env, args[0], id) || !number(env, args[1], pid) || !number(env, args[2], windowId))
    return boolean(env, false);
  auto store = registry(env);
  if (!store) return boolean(env, false);
  auto found = store->leases.find(id);
  if (found == store->leases.end() || found->second->pid != pid || found->second->windowId != windowId)
    return boolean(env, false);
  if (valid(*found->second)) {
    if (!requireForeground) return boolean(env, true);
    const HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(windowId));
    // A live target may no longer own the user's focus. Do not activate it or
    // discard its preview lease when refusing selection-preserving input.
    const HWND foreground = GetForegroundWindow();
    // UIA focus can make Win32 report a child as foreground. Only a retained
    // top-level target includes its same-process children; child targets stay exact.
    return boolean(env, windowOwner(pid, foreground) &&
                            (foreground == window ||
                             (GetAncestor(window, GA_ROOT) == window &&
                              GetAncestor(foreground, GA_ROOT) == window)));
  }
  store->leases.erase(found);
  return boolean(env, false);
}

napi_value validate(napi_env env, napi_callback_info info) {
  return validateLease(env, info, false);
}

napi_value validateForeground(napi_env env, napi_callback_info info) {
  return validateLease(env, info, true);
}

template<class T> struct ComObject {
  T *pointer = nullptr;
  ~ComObject() { if (pointer) pointer->Release(); }
};

struct IconCopy {
  HICON handle = nullptr;
  ~IconCopy() { if (handle) DestroyIcon(handle); }
};

struct IconSurface {
  HDC dc = nullptr;
  HBITMAP bitmap = nullptr;
  HGDIOBJ previous = nullptr;
  uint8_t *pixels = nullptr;
  IconSurface() {
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = 32;
    info.bmiHeader.biHeight = -32;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    dc = CreateCompatibleDC(nullptr);
    if (dc) bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS,
                                      reinterpret_cast<void **>(&pixels), nullptr, 0);
    if (bitmap) previous = SelectObject(dc, bitmap);
  }
  ~IconSurface() {
    if (previous && previous != HGDI_ERROR) SelectObject(dc, previous);
    if (bitmap) DeleteObject(bitmap);
    if (dc) DeleteDC(dc);
  }
  bool ready() const { return dc && bitmap && pixels && previous && previous != HGDI_ERROR; }
};

std::vector<uint8_t> windowIconPng(HWND window) {
  HICON borrowed = nullptr;
  for (WPARAM size : {ICON_SMALL2, ICON_SMALL, ICON_BIG}) {
    DWORD_PTR result = 0;
    if (SendMessageTimeoutW(window, WM_GETICON, size, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK,
                            50, &result) && result) {
      borrowed = reinterpret_cast<HICON>(result);
      break;
    }
  }
  if (!borrowed) borrowed = reinterpret_cast<HICON>(GetClassLongPtrW(window, GCLP_HICONSM));
  if (!borrowed) borrowed = reinterpret_cast<HICON>(GetClassLongPtrW(window, GCLP_HICON));
  if (!borrowed) return {};
  IconCopy icon{CopyIcon(borrowed)};
  if (!icon.handle) return {};
  ICONINFO source{};
  if (!GetIconInfo(icon.handle, &source)) return {};
  BITMAP dimensions{};
  const bool bounded = GetObjectW(source.hbmColor ? source.hbmColor : source.hbmMask,
                                  sizeof(dimensions), &dimensions) &&
      dimensions.bmWidth > 0 && dimensions.bmWidth <= 512 &&
      dimensions.bmHeight > 0 && dimensions.bmHeight <= 1024;
  if (source.hbmColor) DeleteObject(source.hbmColor);
  if (source.hbmMask) DeleteObject(source.hbmMask);
  if (!bounded) return {};

  IconSurface black, white;
  if (!black.ready() || !white.ready()) return {};
  std::memset(black.pixels, 0, 4096);
  std::memset(white.pixels, 255, 4096);
  if (!DrawIconEx(black.dc, 0, 0, icon.handle, 32, 32, 0, nullptr, DI_NORMAL) ||
      !DrawIconEx(white.dc, 0, 0, icon.handle, 32, 32, 0, nullptr, DI_NORMAL)) return {};
  GdiFlush();
  // Rendering against both backgrounds preserves alpha and legacy AND masks.
  // PNG stores straight alpha, while DrawIconEx blends premultiplied colors.
  std::vector<uint8_t> pixels(4096);
  for (size_t offset = 0; offset < pixels.size(); offset += 4) {
    const int alpha = std::clamp(255 - (int(white.pixels[offset]) - black.pixels[offset]), 0, 255);
    pixels[offset + 3] = static_cast<uint8_t>(alpha);
    for (size_t channel = 0; channel < 3; ++channel)
      pixels[offset + channel] = alpha ? static_cast<uint8_t>(
          std::min(255, (int(black.pixels[offset + channel]) * 255 + alpha / 2) / alpha)) : 0;
  }
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return {};
  struct Apartment { bool owned; ~Apartment() { if (owned) CoUninitialize(); } } apartment{SUCCEEDED(initialized)};
  ComObject<IWICImagingFactory> factory;
  ComObject<IStream> stream;
  ComObject<IWICBitmapEncoder> encoder;
  ComObject<IWICBitmapFrameEncode> frame;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&factory.pointer))) ||
      FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream.pointer)) ||
      FAILED(factory.pointer->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder.pointer)) ||
      FAILED(encoder.pointer->Initialize(stream.pointer, WICBitmapEncoderNoCache)) ||
      FAILED(encoder.pointer->CreateNewFrame(&frame.pointer, nullptr)) ||
      FAILED(frame.pointer->Initialize(nullptr)) || FAILED(frame.pointer->SetSize(32, 32))) return {};
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  if (FAILED(frame.pointer->SetPixelFormat(&format)) ||
      !IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA) ||
      FAILED(frame.pointer->WritePixels(32, 128, static_cast<UINT>(pixels.size()), pixels.data())) ||
      FAILED(frame.pointer->Commit()) || FAILED(encoder.pointer->Commit())) return {};
  STATSTG stat{};
  if (FAILED(stream.pointer->Stat(&stat, STATFLAG_NONAME)) || !stat.cbSize.QuadPart ||
      stat.cbSize.QuadPart > 65536) return {};
  LARGE_INTEGER start{};
  if (FAILED(stream.pointer->Seek(start, STREAM_SEEK_SET, nullptr))) return {};
  std::vector<uint8_t> png(static_cast<size_t>(stat.cbSize.QuadPart));
  ULONG read = 0;
  if (FAILED(stream.pointer->Read(png.data(), static_cast<ULONG>(png.size()), &read)) ||
      read != png.size()) return {};
  return png;
}

napi_value applicationIcon(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  std::string id;
  uint32_t pid = 0, windowId = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 3 ||
      !token(env, args[0], id) || !number(env, args[1], pid) || !number(env, args[2], windowId))
    return undefined(env);
  auto store = registry(env);
  if (!store) return undefined(env);
  auto found = store->leases.find(id);
  if (found == store->leases.end() || found->second->pid != pid || found->second->windowId != windowId)
    return undefined(env);
  if (!valid(*found->second)) {
    store->leases.erase(found);
    return undefined(env);
  }
  const auto png = windowIconPng(reinterpret_cast<HWND>(static_cast<uintptr_t>(windowId)));
  if (!valid(*found->second)) {
    store->leases.erase(found);
    return undefined(env);
  }
  if (png.empty()) return undefined(env);
  napi_value out;
  if (napi_create_buffer_copy(env, png.size(), png.data(), nullptr, &out) != napi_ok)
    return undefined(env);
  return out;
}

napi_value release(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  std::string id;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) == napi_ok && argc == 1 &&
      token(env, args[0], id)) {
    if (auto store = registry(env)) store->leases.erase(id);
  }
  return undefined(env);
}
napi_value dispose(napi_env env, napi_callback_info) {
  if (auto store = registry(env)) store->leases.clear();
  return undefined(env);
}

struct OwnedWindow {
  uint32_t id;
  RECT bounds;
  std::string title;
  bool dialog;
};
struct WindowEnumeration { uint32_t pid; std::vector<OwnedWindow> windows; };

BOOL CALLBACK collectOwnedWindow(HWND window, LPARAM parameter) {
  auto &result = *reinterpret_cast<WindowEnumeration *>(parameter);
  const uintptr_t id = reinterpret_cast<uintptr_t>(window);
  if (!id || id > UINT32_MAX || !windowOwner(result.pid, window) ||
      !IsWindowVisible(window) || IsIconic(window)) return TRUE;
  RECT bounds{};
  if (!GetWindowRect(window, &bounds) || bounds.right <= bounds.left ||
      bounds.bottom <= bounds.top) return TRUE;
  wchar_t title[4096]{}, className[256]{};
  const int length = GetWindowTextW(window, title, 4096);
  GetClassNameW(window, className, 256);
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, title, length, nullptr, 0, nullptr, nullptr);
  std::string utf8(bytes, '\0');
  if (bytes) WideCharToMultiByte(CP_UTF8, 0, title, length, utf8.data(), bytes, nullptr, nullptr);
  if (!windowOwner(result.pid, window)) return TRUE;
  // Owned top-level dialogs are task windows even when the picker omits them.
  const bool dialog = GetWindow(window, GW_OWNER) != nullptr ||
                      std::wcscmp(className, L"#32770") == 0;
  result.windows.push_back({static_cast<uint32_t>(id), bounds, std::move(utf8), dialog});
  return result.windows.size() < MAX_LISTED_WINDOWS ? TRUE : FALSE;
}

napi_value listOwnedWindows(napi_env env, napi_callback_info info) {
  napi_value out; napi_create_array(env, &out);
  size_t argc = 1; napi_value args[1]; uint32_t pid = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
      !number(env, args[0], pid)) return out;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  FILETIME before{}, after{};
  if (!process || !processStart(process, before)) {
    if (process) CloseHandle(process);
    return out;
  }
  WindowEnumeration result{pid, {}};
  const auto previousDpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const bool enumerated = EnumWindows(collectOwnedWindow, reinterpret_cast<LPARAM>(&result));
  if (previousDpi) SetThreadDpiAwarenessContext(previousDpi);
  const bool sameProcess = processStart(process, after) && CompareFileTime(&before, &after) == 0;
  CloseHandle(process);
  // A full bounded prefix does not claim that enumeration was exhaustive.
  if ((!enumerated && result.windows.size() < MAX_LISTED_WINDOWS) || !sameProcess) return out;
  uint32_t index = 0;
  for (const auto &window : result.windows) {
    napi_value item, field; napi_create_object(env, &item);
    auto setNumber = [&](const char *name, double value) {
      napi_create_double(env, value, &field); napi_set_named_property(env, item, name, field);
    };
    setNumber("pid", pid); setNumber("windowId", window.id);
    setNumber("x", window.bounds.left); setNumber("y", window.bounds.top);
    setNumber("width", window.bounds.right - window.bounds.left);
    setNumber("height", window.bounds.bottom - window.bounds.top);
    napi_create_string_utf8(env, window.title.c_str(), window.title.size(), &field);
    napi_set_named_property(env, item, "title", field);
    napi_create_string_utf8(env, window.dialog ? "dialog" : "window", NAPI_AUTO_LENGTH, &field);
    napi_set_named_property(env, item, "role", field);
    napi_set_element(env, out, index++, item);
  }
  return out;
}
napi_value initialize(napi_env env, napi_value exports) {
  napi_set_instance_data(env, new Registry(), [](napi_env, void *data, void *) {
    delete static_cast<Registry *>(data);
  }, nullptr);
  const napi_property_descriptor methods[] = {
    {"acquire", nullptr, acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"validate", nullptr, validate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"validateForeground", nullptr, validateForeground, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"applicationIcon", nullptr, applicationIcon, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listOwnedWindows", nullptr, listOwnedWindows, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
