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

#include "bgra-capture.h"
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Accelerate/Accelerate.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <vector>

namespace maka_preview { struct State; }

API_AVAILABLE(macos(12.3))
@interface MakaBGRAOutput : NSObject <SCStreamOutput, SCStreamDelegate> {
 @public
  std::weak_ptr<maka_preview::State> owner;
}
@end

namespace maka_preview {
constexpr size_t kMaxSourceDimension = 8192;
constexpr size_t kMaxSourcePixels = 8388608;
constexpr size_t kMaxSourceBytes = 40 * 1024 * 1024;
struct State {
  CaptureSpec spec;
  std::function<bool()> validator;
  std::atomic<bool> active{true};
  std::atomic<bool> terminal{false};
  std::atomic<bool> framePending{false};
  std::atomic<uint64_t> sequence{0};
  std::atomic<uint64_t> dropped{0};
  std::mutex bridgeMutex;
  napi_threadsafe_function bridge = nullptr;
  dispatch_queue_t controlQueue;
  dispatch_queue_t frameQueue;
  SCStream *stream API_AVAILABLE(macos(12.3));
  MakaBGRAOutput *output API_AVAILABLE(macos(12.3));
  CGColorRef background = nullptr;
  ~State() { if (background) CGColorRelease(background); }
};

struct Event {
  std::shared_ptr<State> state;
  std::string status;
  std::string reason;
  std::vector<uint8_t> bytes;
  size_t width = 0, height = 0, stride = 0;
  double timestamp = 0;
  uint64_t sequence = 0;
};

void stop(std::shared_ptr<State> state) {
  if (!state->active.exchange(false)) return;
  // Serialize abort with producers. Queued callbacks only free their buffers.
  {
    std::lock_guard lock(state->bridgeMutex);
    if (state->bridge) {
      napi_release_threadsafe_function(state->bridge, napi_tsfn_abort);
      state->bridge = nullptr;
    }
  }
  dispatch_async(state->controlQueue, ^{
    if (@available(macOS 12.3, *)) {
      SCStream *stream = state->stream;
      state->stream = nil;
      MakaBGRAOutput *output = state->output;
      state->output = nil;
      if (stream) {
        [stream stopCaptureWithCompletionHandler:^(NSError *) {
          NSError *error = nil;
          [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:&error];
        }];
      }
    }
  });
}

bool enqueue(std::unique_ptr<Event> event) {
  auto state = event->state;
  std::lock_guard lock(state->bridgeMutex);
  if (!state->active || !state->bridge) return false;
  if (napi_call_threadsafe_function(state->bridge, event.get(), napi_tsfn_nonblocking) != napi_ok)
    return false;
  event.release();
  return true;
}

void fail(const std::shared_ptr<State> &state, const char *status, const char *reason) {
  if (!state->active || state->terminal.exchange(true)) return;
  auto event = std::make_unique<Event>();
  event->state = state;
  event->status = status;
  event->reason = reason;
  // At most one frame and one terminal event can be queued.
  if (!enqueue(std::move(event))) stop(state);
}

bool setString(napi_env env, napi_value object, const char *key, const std::string &value) {
  napi_value text;
  return napi_create_string_utf8(env, value.c_str(), value.size(), &text) == napi_ok &&
         napi_set_named_property(env, object, key, text) == napi_ok;
}
bool setNumber(napi_env env, napi_value object, const char *key, double value) {
  napi_value number;
  return napi_create_double(env, value, &number) == napi_ok &&
         napi_set_named_property(env, object, key, number) == napi_ok;
}

void deliver(napi_env env, napi_value callback, void *, void *data) {
  std::unique_ptr<Event> event(static_cast<Event *>(data));
  auto state = event->state;
  if (event->status.empty()) state->framePending = false;
  if (!env || !callback || !state->active) return;
  if (event->status.empty() && !state->validator()) {
    event->status = "stopped";
    event->reason = "window_identity_changed";
  }
  napi_value value, receiver;
  bool ok = napi_create_object(env, &value) == napi_ok &&
            setString(env, value, "type", event->status.empty() ? "frame" : "status") &&
            setString(env, value, "captureId", state->spec.id) &&
            setString(env, value, "leaseId", state->spec.leaseId) &&
            setNumber(env, value, "pid", state->spec.pid) &&
            setNumber(env, value, "windowId", state->spec.windowId);
  if (event->status.empty()) {
    napi_value bytes;
    // Electron's V8 memory cage does not permit external ArrayBuffer storage.
    ok = ok && napi_create_buffer_copy(env, event->bytes.size(), event->bytes.data(), nullptr, &bytes) == napi_ok &&
         napi_set_named_property(env, value, "data", bytes) == napi_ok &&
         setString(env, value, "format", "BGRA") &&
         setString(env, value, "colorSpace", "srgb") &&
         setNumber(env, value, "width", event->width) &&
         setNumber(env, value, "height", event->height) &&
         setNumber(env, value, "stride", event->stride) &&
         setNumber(env, value, "timestampMicros", event->timestamp) &&
         setNumber(env, value, "sequence", event->sequence) &&
         setNumber(env, value, "droppedFrames", state->dropped);
  } else {
    ok = ok && setString(env, value, "status", event->status) &&
         setString(env, value, "reason", event->reason);
  }
  if (ok && napi_get_undefined(env, &receiver) == napi_ok)
    ok = napi_call_function(env, receiver, callback, 1, &value, nullptr) == napi_ok;
  if (!ok || !event->status.empty()) stop(state);
}

void receive(const std::shared_ptr<State> &state, CMSampleBufferRef sample) {
  if (!state->active || state->terminal || !CMSampleBufferIsValid(sample)) return;
  if (@available(macOS 12.3, *)) {
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (!attachments || CFArrayGetCount(attachments) == 0) return;
    NSDictionary *attachment = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *status = attachment[SCStreamFrameInfoStatus];
    if (!status || status.integerValue != SCFrameStatusComplete) return;
  }
  CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(sample);
  if (!pixel || CVPixelBufferGetPixelFormatType(pixel) != kCVPixelFormatType_32BGRA ||
      CVPixelBufferIsPlanar(pixel)) return;
  const size_t width = CVPixelBufferGetWidth(pixel), height = CVPixelBufferGetHeight(pixel);
  const size_t stride = CVPixelBufferGetBytesPerRow(pixel);
  // Dimensions and padding are checked before allocating or reading native memory.
  if (!width || !height || width > kMaxSourceDimension || height > kMaxSourceDimension ||
      width * height > kMaxSourcePixels || stride < width * 4 || stride > width * 4 + 4096 ||
      stride * height > kMaxSourceBytes) {
    fail(state, "capture_failed", "invalid_frame_layout");
    return;
  }
  double timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000000.0;
  if (!std::isfinite(timestamp) || timestamp < 0 || timestamp > 9007199254740991.0) return;
  timestamp = std::round(timestamp);
  uint64_t sequence = ++state->sequence;
  if (state->framePending.exchange(true)) { ++state->dropped; return; }
  if (CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
    state->framePending = false;
    return;
  }
  auto event = std::make_unique<Event>();
  const void *base = CVPixelBufferGetBaseAddress(pixel);
  bool copied = false;
  if (base) {
    event->state = state;
    const double scale = std::min({1.0, static_cast<double>(state->spec.maxWidth) / width,
                                 static_cast<double>(state->spec.maxHeight) / height});
    event->width = std::max<size_t>(1, std::floor(width * scale));
    event->height = std::max<size_t>(1, std::floor(height * scale));
    event->stride = event->width * 4;
    event->timestamp = timestamp; event->sequence = sequence;
    event->bytes.resize(event->stride * event->height);
    if (event->width == width && event->height == height) {
      for (size_t row = 0; row < height; ++row)
        std::memcpy(event->bytes.data() + row * event->stride,
                    static_cast<const uint8_t *>(base) + row * stride, event->stride);
      copied = true;
    } else {
      // Scaling inside ScreenCaptureKit can return zeroed pixels on software GPUs.
      // vImage scales the four components on the CPU without changing BGRA order.
      vImage_Buffer source{const_cast<void *>(base), height, width, stride};
      vImage_Buffer destination{event->bytes.data(), event->height, event->width, event->stride};
      copied = vImageScale_ARGB8888(&source, &destination, nullptr, kvImageHighQualityResampling) == kvImageNoError;
    }
  }
  CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
  if (base && !copied) {
    state->framePending = false;
    fail(state, "capture_failed", "cpu_scaling_failed");
    return;
  }
  if (!copied || !enqueue(std::move(event))) {
    state->framePending = false;
    ++state->dropped;
  }
}

class NativeCapture final : public Capture {
 public:
  explicit NativeCapture(std::shared_ptr<State> state) : state_(std::move(state)) {}
  ~NativeCapture() override { stop(); }
  void stop() override { maka_preview::stop(state_); }
 private:
  std::shared_ptr<State> state_;
};

std::shared_ptr<Capture> startBGRA(napi_env env, const CaptureSpec &spec,
                                  std::function<bool()> validator, napi_value callback) {
  if (@available(macOS 12.3, *)) {
    auto state = std::make_shared<State>();
    state->spec = spec;
    state->validator = std::move(validator);
    state->controlQueue = dispatch_queue_create("org.apache.maka.preview.control", DISPATCH_QUEUE_SERIAL);
    state->frameQueue = dispatch_queue_create("org.apache.maka.preview.frames", DISPATCH_QUEUE_SERIAL);
    napi_value name;
    if (napi_create_string_utf8(env, "Maka fixed-window BGRA", NAPI_AUTO_LENGTH, &name) != napi_ok) return {};
    auto retained = std::make_unique<std::shared_ptr<State>>(state);
    if (napi_create_threadsafe_function(env, callback, nullptr, name, 2, 1, retained.get(),
        [](napi_env, void *data, void *) { delete static_cast<std::shared_ptr<State> *>(data); },
        nullptr, deliver, &state->bridge) != napi_ok) return {};
    retained.release();
    napi_unref_threadsafe_function(env, state->bridge);
    auto result = std::make_shared<NativeCapture>(state);
    dispatch_async(state->controlQueue, ^{
      if (!state->active) return;
      if (!CGPreflightScreenCaptureAccess()) {
        fail(state, "permission_denied", "screen_recording_permission_required");
        return;
      }
      [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO
          completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(state->controlQueue, ^{
          if (!state->active) return;
          if (error || !content) { fail(state, "capture_failed", "shareable_content_failed"); return; }
          SCWindow *target = nil;
          for (SCWindow *window in content.windows) {
            if (window.windowID == state->spec.windowId &&
                window.owningApplication.processID == static_cast<pid_t>(state->spec.pid)) {
              if (target) { fail(state, "stopped", "ambiguous_window_identity"); return; }
              target = window;
            }
          }
          if (!target || !state->validator()) { fail(state, "stopped", "window_identity_changed"); return; }
          SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
          double width = target.frame.size.width, height = target.frame.size.height;
          if (@available(macOS 14.0, *)) {
            width = filter.contentRect.size.width * filter.pointPixelScale;
            height = filter.contentRect.size.height * filter.pointPixelScale;
          }
          if (!(width > 0) || !(height > 0) || !std::isfinite(width) || !std::isfinite(height)) {
            fail(state, "capture_failed", "invalid_window_dimensions"); return;
          }
          width = std::ceil(width); height = std::ceil(height);
          if (width > kMaxSourceDimension || height > kMaxSourceDimension || width * height > kMaxSourcePixels) {
            fail(state, "capture_failed", "source_window_too_large"); return;
          }
          SCStreamConfiguration *config = [SCStreamConfiguration new];
          config.width = width;
          config.height = height;
          config.pixelFormat = kCVPixelFormatType_32BGRA;
          config.colorSpaceName = kCGColorSpaceSRGB;
          config.minimumFrameInterval = CMTimeMake(1, state->spec.fps);
          config.queueDepth = 3;
          config.showsCursor = YES;
          config.scalesToFit = YES;
          // SCStreamConfiguration does not retain this CF color. Keep it alive
          // through start and asynchronous stream teardown.
          state->background = CGColorCreateGenericRGB(0, 0, 0, 1);
          config.backgroundColor = state->background;
          MakaBGRAOutput *output = [MakaBGRAOutput new];
          output->owner = state;
          SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];
          NSError *addError = nil;
          if (![stream addStreamOutput:output type:SCStreamOutputTypeScreen
                   sampleHandlerQueue:state->frameQueue error:&addError]) {
            fail(state, "capture_failed", "stream_output_failed"); return;
          }
          state->output = output;
          state->stream = stream;
          [stream startCaptureWithCompletionHandler:^(NSError *startError) {
            // A stop can arrive while ScreenCaptureKit is still starting.
            // Retry teardown after that completion, even if the earlier stop failed.
            if (!state->active) {
              [stream stopCaptureWithCompletionHandler:^(NSError *) {
                NSError *removeError = nil;
                [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:&removeError];
              }];
              return;
            }
            if (startError) fail(state, "capture_failed", "stream_start_failed");
          }];
        });
      }];
    });
    return result;
  }
  return {};
}
} // namespace maka_preview

@implementation MakaBGRAOutput
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample
        ofType:(SCStreamOutputType)type {
  if (type == SCStreamOutputTypeScreen) {
    if (auto state = owner.lock()) maka_preview::receive(state, sample);
  }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  if (auto state = owner.lock()) maka_preview::fail(state, "capture_failed", "stream_stopped_with_error");
}
@end
