APP := chrome-bridge
CMD := ./cmd/chrome-bridge
LDFLAGS :=

ifneq ($(strip $(PORT)),)
LDFLAGS += -X main.defaultPort=$(PORT)
endif

# 支持的平台: GOOS_GOARCH => 输出后缀
PLATFORMS := \
	linux_amd64 \
	linux_arm64 \
	darwin_amd64 \
	darwin_arm64 \
	windows_amd64 \
	windows_arm64

.PHONY: build build-all test clean $(PLATFORMS)

# 当前平台构建
build:
	env -u GOROOT go build $(if $(LDFLAGS),-ldflags "$(LDFLAGS)") -o ./bin/$(APP) $(CMD)

# 构建所有平台
build-all: $(PLATFORMS)

# 通用交叉编译模板
# 调用方式: make linux_amd64  /  make darwin_arm64  等
define build_platform
$(1):
	@mkdir -p ./bin
	@GOOS=$$(word 1,$$(subst _, ,$(1))); \
	GOARCH=$$(word 2,$$(subst _, ,$(1))); \
	EXT=""; \
	if [ "$$$$GOOS" = "windows" ]; then EXT=".exe"; fi; \
	env -u GOROOT GOOS=$$$$GOOS GOARCH=$$$$GOARCH CGO_ENABLED=0 \
		go build $(if $(LDFLAGS),-ldflags "$(LDFLAGS)") \
		-o ./bin/$(APP)-$$$$GOOS-$$$$GOARCH$$$$EXT $(CMD); \
	echo "✓ Built ./bin/$(APP)-$$$$GOOS-$$$$GOARCH$$$$EXT"
endef

$(foreach p,$(PLATFORMS),$(eval $(call build_platform,$(p))))

test:
	env -u GOROOT GOTOOLCHAIN=local go test ./...

clean:
	rm -f ./bin/$(APP)
	rm -f ./bin/$(APP)-*
