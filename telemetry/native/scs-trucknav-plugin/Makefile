SDK_DIR ?= vendor/scs-sdk
OUT_DIR ?= ../../../electron/bin/darwin-x64
PLUGIN_NAME ?= scs-trucknav.so
CXX ?= clang++

SDK_INCLUDES = \
	-I$(SDK_DIR)/include \
	-I$(SDK_DIR)/include/common \
	-I$(SDK_DIR)/include/amtrucks \
	-I$(SDK_DIR)/include/eurotrucks2

CXXFLAGS ?= -std=c++17 -O2 -fPIC -Wall -Wextra -arch x86_64

.PHONY: darwin clean

darwin: $(OUT_DIR)/$(PLUGIN_NAME)

$(OUT_DIR)/$(PLUGIN_NAME): src/trucknav_telemetry.cpp
	@mkdir -p $(OUT_DIR)
	$(CXX) $(CXXFLAGS) -shared -Wl,-install_name,$(PLUGIN_NAME) $(SDK_INCLUDES) $< -o $@

clean:
	@rm -f $(OUT_DIR)/$(PLUGIN_NAME)
