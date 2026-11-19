# bbkangaroo: fork of RCKangaroo v3.1 (GPLv3) with BumbleBeam changes. Linux build.
NVCC ?= nvcc
CCBIN ?= $(shell command -v g++-12 >/dev/null 2>&1 && echo g++-12 || echo g++)
ARCH ?= 86
CUDA_INC ?= $(shell dirname $$(dirname $$(command -v $(NVCC))))/include
CXX := $(CCBIN)
CXXFLAGS := -O3 -std=c++17 -I$(CUDA_INC) -Wno-unknown-pragmas
NVCCFLAGS := -O3 -ccbin $(CCBIN) $(foreach a,$(ARCH),-gencode=arch=compute_$(a),code=sm_$(a)) -Xptxas -v
LDFLAGS := -lcudart -pthread

CPU_SRC := RCKangaroo.cpp GpuKang.cpp Ec.cpp utils.cpp
GPU_SRC := RCGpuCore.cu
OBJ := $(CPU_SRC:.cpp=.o) $(GPU_SRC:.cu=.o)
TARGET := bbkangaroo

all: $(TARGET)
$(TARGET): $(OBJ)
	$(CXX) -o $@ $^ $(LDFLAGS)
%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@
%.o: %.cu
	$(NVCC) $(NVCCFLAGS) -c $< -o $@ 2> $<.ptxas.log
clean:
	rm -f $(OBJ) $(TARGET) *.ptxas.log
.PHONY: all clean
