const fence = gpu.createFence(0);

scheduler.spawnFunction(async () => {
  const cb = gpu.createCommandBuffer();
  cb.clear({ r: 0, g: 0, b: 0, a: 255 });
  cb.draw({ vertexCount: 3 });
  cb.signalFence({ fence, value: 1 });
  cb.present();
  gpu.submitCommandBuffer(cb);
}, { name: "render", priority: 0 });
