const swift = useSwiftUI();

useEffect(() => {
  const player = AVKit.AVPlayer({
    src: "https://example.com/video.mp4",
    loop: true,
    muted: false,
    autoplay: true,
  });

  const playerLayer = AVKit.AVPlayerLayer({
    player,
    videoGravity: "resizeAspect",
  });

  const root = SwiftUI.VStack(
    [
      SwiftUI.Text("Reproductor", { fontSize: 24 }),
      playerLayer.frame({ width: 640, height: 360 }),
    ],
    { spacing: 16, padding: 20 }
  );

  swift.setRoot(root);
}, [swift]);
