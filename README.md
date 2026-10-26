# R3F Painterly Cafe

A web application that renders a 3D cafe scene as a painting, built using React Three Fiber (R3F) and Three.js (WebGPU / TSL).

The scene is modeled and light-baked in Blender, then painted in real time with an anisotropic Kuwahara filter and hand-drawn-style outlines. Moving the cursor leaves brush strokes on the canvas.

## Demo

- [View Demo](https://r3f-painterly-cafe.vercel.app/)

## Getting Started

### Prerequisites

- Node.js
- A browser with WebGPU support (add `?webgl` to the URL to fall back to WebGL2)

### Installation

1. Install dependencies
```
npm install
```

2. Start the development server
```
npm run dev
```

3. Open ```http://localhost:5173``` in your browser.

## 3D Assets

The Blender source file is in `_3d_assets/Models.blend` (Blender 5.2).

The raw 8K light bake (`_3d_assets/Cafe_Bake.hdr`) is not included because it exceeds GitHub's file size limit, so the bake texture shows as missing when you open the file. The denoised bake used by the app is in `public/textures/Cafe_Bake.png`.
