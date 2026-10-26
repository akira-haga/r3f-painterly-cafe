import { Canvas, extend, type ThreeToJSXElements } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Suspense, useCallback, useState } from "react";
import { Scene } from "./components/Scene";
import { QualityNotice } from "./components/QualityNotice";
import { LoadingScreen } from "./components/LoadingScreen";
import { type WebGPURendererParameters } from "three/src/renderers/webgpu/WebGPURenderer.js";
import * as THREE from "three/webgpu";

declare module "@react-three/fiber" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
extend(THREE as any);

export default function App() {
  const [autoLow, setAutoLow] = useState<{
    ms: number;
    restore: () => void;
  } | null>(null);

  const handleAutoLow = useCallback(
    (info: { ms: number; restore: () => void }) => setAutoLow(info),
    [],
  );

  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);

  const [entered, setEntered] = useState(false);
  const handleEntered = useCallback(() => setEntered(true), []);

  return (
    <div className="w-full h-screen">
      <Canvas
        flat
        frameloop="demand"
        dpr={[1, 1]}
        camera={{ position: [19, 3.5, 16], fov: 22.9 }}
        gl={async (props) => {
          const forceWebGL = new URLSearchParams(location.search).has("webgl");
          const renderer = new THREE.WebGPURenderer({
            ...(props as WebGPURendererParameters),
            forceWebGL,
            trackTimestamp: true,
          } as WebGPURendererParameters);
          renderer.toneMapping = THREE.NoToneMapping;
          await renderer.init();
          const backend = (
            renderer.backend as unknown as { isWebGLBackend?: boolean }
          ).isWebGLBackend
            ? "WebGL2"
            : "WebGPU";
          console.warn(`renderer backend: ${backend}`);
          return renderer;
        }}
      >
        <color attach="background" args={["#E7E7E7"]} />
        <Suspense fallback={null}>
          <Scene onAutoLow={handleAutoLow} onReady={handleReady} />
        </Suspense>
        <OrbitControls
          target={[0, 3.15, 0]}
          maxDistance={24.85}
          maxPolarAngle={Math.PI / 2}
          minPolarAngle={THREE.MathUtils.degToRad(90 - 5)}
        />
      </Canvas>

      {autoLow && entered && (
        <QualityNotice
          ms={autoLow.ms}
          onRestore={() => {
            autoLow.restore();
            setAutoLow(null);
          }}
          onDismiss={() => setAutoLow(null)}
        />
      )}

      {!entered && <LoadingScreen ready={ready} onEntered={handleEntered} />}
    </div>
  );
}
