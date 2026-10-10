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

#pragma once
#include <node_api.h>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace maka_preview {
struct CaptureSpec {
  std::string id;
  std::string leaseId;
  uint32_t pid;
  uint32_t windowId;
  uint32_t maxWidth;
  uint32_t maxHeight;
  uint32_t fps;
};
class Capture {
 public:
  virtual ~Capture() = default;
  virtual void stop() = 0;
};
// The validator retains the exact AX identity, and must fail after lease release.
std::shared_ptr<Capture> startBGRA(napi_env env, const CaptureSpec &spec,
                                  std::function<bool()> validator, napi_value callback);
}
