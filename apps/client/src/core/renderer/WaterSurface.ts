import * as THREE from "three";

/** 只装配明确标记的新湖面，不改变用户的水材质或图片资源。 */
export class WaterSurfaceEffect {
	private materials = new Set<THREE.ShaderMaterial>();
	private prepared = new WeakSet<THREE.Mesh>();

	prepare(root: THREE.Object3D): void {
		root.traverse((object) => {
			if (!(object instanceof THREE.Mesh) || object.userData.china24WaterSurface !== true || this.prepared.has(object))
				return;
			const material = new THREE.ShaderMaterial({
				uniforms: {
					uTime: { value: 0 },
					uDeep: { value: new THREE.Color("#277b9b") },
					uShallow: { value: new THREE.Color("#72becb") },
					uFoam: { value: new THREE.Color("#d5f2ec") },
				},
				vertexShader: `
					varying vec2 vWaterUv;
					void main() {
						vWaterUv = uv;
						gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
					}
				`,
				fragmentShader: `
					uniform float uTime;
					uniform vec3 uDeep;
					uniform vec3 uShallow;
					uniform vec3 uFoam;
					varying vec2 vWaterUv;
					void main() {
						vec2 p = vWaterUv * 2.0 - 1.0;
						vec2 q = abs(p) - vec2(0.76);
						float edge = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.20;
						float alpha = 1.0 - smoothstep(-0.025, 0.055, edge);
						if (alpha < 0.01) discard;
						vec2 uv = vWaterUv * 18.0;
						float wave = sin(uv.x * 0.82 + uv.y * 0.46 + uTime * 0.28);
						wave += sin(uv.y * 1.12 - uv.x * 0.36 - uTime * 0.21);
						float streak = sin(uv.x * 2.7 + sin(uv.y * 1.8 + uTime * 0.15));
						streak += sin(uv.y * 2.5 + sin(uv.x * 1.6 - uTime * 0.12));
						float caustic = pow(clamp(1.0 - abs(streak) * 2.1, 0.0, 1.0), 4.0);
						float shallowness = 0.36 + wave * 0.07 + length(p) * 0.14;
						vec3 color = mix(uDeep, uShallow, clamp(shallowness, 0.0, 1.0));
						color = mix(color, uFoam, caustic * 0.15);
						gl_FragColor = vec4(color, alpha * 0.94);
						#include <tonemapping_fragment>
						#include <colorspace_fragment>
					}
				`,
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide,
			});
			material.name = "china24-lake-water";
			object.material = material;
			object.castShadow = false;
			object.receiveShadow = false;
			object.renderOrder = -1;
			this.prepared.add(object);
			this.materials.add(material);
		});
	}

	update(delta: number): void {
		if (!Number.isFinite(delta) || delta <= 0) return;
		for (const material of this.materials) material.uniforms.uTime.value += Math.min(delta, 1);
	}

	dispose(): void {
		for (const material of this.materials) material.dispose();
		this.materials.clear();
		this.prepared = new WeakSet<THREE.Mesh>();
	}
}
