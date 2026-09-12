const view = UIKit.UIView({
  frame: { x: 0, y: 0, width: 400, height: 300 },
  backgroundColor: Color.named("systemBackground"),
});

const label = UIKit.UILabel({
  text: "Hola UIKit",
  font: { size: 24, weight: 600 },
  textColor: Color.hex("#007aff"),
});

view.addChild(label);

view.addChild(
  UIKit.UIButton({
    title: "Pulsar",
    action: () => alert("pulsado"),
  })
);
