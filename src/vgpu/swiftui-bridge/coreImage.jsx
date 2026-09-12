const ciContext = new CIContext({ gpu });

const blur = CoreImage.filter("CIGaussianBlur", { radius: 20 });
const vibrance = CoreImage.filter("CIVibrance", { amount: 0.5 });
const hue = CoreImage.filter("CIHueAdjust", { angle: Math.PI / 4 });

const filtered = ciContext.render([blur, vibrance, hue], texture);
