import {
  VgpuProvider,
} from "rainOS";
import {
  SwiftUIProvider,
  useSwiftUI,
  SwiftUI,
  UIKit,
  AVKit,
  CoreImage,
  CoreAnimation,
  Color,
} from "rainOS/swiftui-bridge";

function SwiftApp() {
  const swift = useSwiftUI();

  useEffect(() => {
    // Construir la interfaz con la DSL de SwiftUI
    const root = SwiftUI.VStack(
      [
        SwiftUI.Text("Hola rainOS", {
          fontSize: 32,
          fontWeight: 700,
          color: Color.named("label"),
        }),
        SwiftUI.Text("Esto es SwiftUI corriendo en la VGPU", {
          fontSize: 17,
          color: Color.named("secondaryLabel"),
        }),
        SwiftUI.HStack(
          [
            SwiftUI.Button({
              label: SwiftUI.Text("Aceptar"),
              action: () => console.log("aceptado"),
            }),
            SwiftUI.Button({
              label: SwiftUI.Text("Cancelar"),
              action: () => console.log("cancelado"),
            }),
          ],
          { spacing: 12 }
        ),
      ],
      { spacing: 16, padding: 24 }
    );

    // Aplicar animaciones
    const title = root.children[0];
    swift.addAnimation(title, CoreAnimation.fadeIn(0.6));

    // Establecer como raíz
    swift.setRoot(root);
  }, [swift]);

  return null;
}

export default function App() {
  return (
    <VgpuProvider options={{ vramBytes: 512 * 1024 * 1024 }}>
      <SwiftUIProvider>
        <SwiftApp />
      </SwiftUIProvider>
    </VgpuProvider>
  );
}
