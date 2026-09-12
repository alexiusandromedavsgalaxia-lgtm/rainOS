const compiled = swift.compileMetalShader(`
  #include <metal_stdlib>
  using namespace metal;

  vertex float4 vertexShader(uint vid [[vertex_id]]) {
    return float4(0.0, 0.0, 0.0, 1.0);
  }

  fragment float4 fragmentShader() {
    return float4(1.0, 0.0, 0.0, 1.0);
  }
`, { stage: "vertex", entry: "vertexShader" });
