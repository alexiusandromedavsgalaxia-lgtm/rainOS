// 1. Compilar shaders VSL
const vs = gpu.compileShader(`
  mov r0, v0
  mov o0, r0
`, SHADER_STAGE.VERTEX);

const fs = gpu.compileShader(`
  mov r0, v0
  mov o0, r0
`, SHADER_STAGE.FRAGMENT);

// 2. Crear geometría
const vertices = new Float32Array([
  0.0,  0.5, 0.0, 1.0,   1.0, 0.0, 0.0, 1.0,   // rojo
  0.5, -0.5, 0.0, 1.0,   0.0, 1.0, 0.0, 1.0,   // verde
 -0.5, -0.5, 0.0, 1.0,   0.0, 0.0, 1.0, 1.0,   // azul
]);

const vbo = gpu.createBuffer({
  bytes: vertices.byteLength,
  data: new Uint8Array(vertices.buffer),
  tag: "triangle-vbo",
});

// 3. Configurar pipeline y dibujar
const cb = gpu.createCommandBuffer();
cb.setPipeline({
  vertexShader: vs,
  fragmentShader: fs,
  topology: PRIMITIVE_TOPOLOGY.TRIANGLE_LIST,
  cullMode: CULL_MODE.NONE,
});
cb.setRenderTarget({ renderTarget: gpu.defaultRenderTarget });
cb.bindVertexBuffer({ buffer: vbo, stride: 32 });
cb.clear({ r: 0, g: 0, b: 0, a: 255 });
cb.draw({ vertexCount: 3 });
cb.present();
gpu.submitCommandBuffer(cb);
gpu.executeCommandBuffers();

// 4. Ver el pixel (0, 0)
console.log(gpu.dumpFramebufferPixels(400, 300, 4, 4));
