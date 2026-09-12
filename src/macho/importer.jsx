import { createExecutor } from "rainOS/macho/xcode-executor";
import { MachoLoader } from "rainOS/macho";

// 1. Cargar el Mach-O
const loader = new MachoLoader({ vcpu });
const file = await loader.load(bytes, { path: "/usr/bin/hello" });

// 2. Crear el ejecutor según la arquitectura detectada
const executor = createExecutor(vcpu, file.arch);

// 3. Ejecutar
const instructions = executor.run(1_000_000);

console.log(`Ejecutadas ${instructions} instrucciones`);
console.log(`Estado: ${executor.state}`);
