const { nativeImage } = require("electron");
const fs = require("fs");
const src = nativeImage.createFromPath("build/icon.png");
if (src.isEmpty()) { console.error("EMPTY source"); process.exit(1); }
fs.mkdirSync("build/icons", { recursive: true });
for (const sz of [512, 256, 128, 96, 64, 48, 32, 16]) {
  const img = src.resize({ width: sz, height: sz, quality: "best" });
  fs.writeFileSync(`build/icons/${sz}x${sz}.png`, img.toPNG());
}
console.log("generated sizes:", fs.readdirSync("build/icons").join(", "));
process.exit(0);
