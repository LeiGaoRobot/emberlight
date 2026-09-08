/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/three@0.184.0/examples/jsm/postprocessing/UnrealBloomPass.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
import{OrthographicCamera as C,BufferGeometry as _,Float32BufferAttribute as x,Mesh as w,Color as v,Vector2 as n,WebGLRenderTarget as p,HalfFloatType as g,UniformsUtils as M,ShaderMaterial as f,Vector3 as m,AdditiveBlending as y,MeshBasicMaterial as U}from"/npm/three@0.184.0/+esm";class B{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}const D=new C(-1,1,1,-1,0,1);class F extends _{constructor(){super(),this.setAttribute("position",new x([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new x([0,2,0,0,2,0],2))}}const z=new F;class P{constructor(e){this._mesh=new w(z,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,D)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}const b={uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}`},R={uniforms:{tDiffuse:{value:null},luminosityThreshold:{value:1},smoothWidth:{value:1},defaultColor:{value:new v(0)},defaultOpacity:{value:0}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			float v = luminance( texel.xyz );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`};class h extends B{constructor(e,l=1,r,i){super(),this.strength=l,this.radius=r,this.threshold=i,this.resolution=e!==void 0?new n(e.x,e.y):new n(256,256),this.clearColor=new v(0,0,0),this.needsSwap=!1,this.renderTargetsHorizontal=[],this.renderTargetsVertical=[],this.nMips=5;let t=Math.round(this.resolution.x/2),o=Math.round(this.resolution.y/2);this.renderTargetBright=new p(t,o,{type:g}),this.renderTargetBright.texture.name="UnrealBloomPass.bright",this.renderTargetBright.texture.generateMipmaps=!1;for(let a=0;a<this.nMips;a++){const c=new p(t,o,{type:g});c.texture.name="UnrealBloomPass.h"+a,c.texture.generateMipmaps=!1,this.renderTargetsHorizontal.push(c);const d=new p(t,o,{type:g});d.texture.name="UnrealBloomPass.v"+a,d.texture.generateMipmaps=!1,this.renderTargetsVertical.push(d),t=Math.round(t/2),o=Math.round(o/2)}const u=R;this.highPassUniforms=M.clone(u.uniforms),this.highPassUniforms.luminosityThreshold.value=i,this.highPassUniforms.smoothWidth.value=.01,this.materialHighPassFilter=new f({uniforms:this.highPassUniforms,vertexShader:u.vertexShader,fragmentShader:u.fragmentShader}),this.separableBlurMaterials=[];const s=[6,10,14,18,22];t=Math.round(this.resolution.x/2),o=Math.round(this.resolution.y/2);for(let a=0;a<this.nMips;a++)this.separableBlurMaterials.push(this._getSeparableBlurMaterial(s[a])),this.separableBlurMaterials[a].uniforms.invSize.value=new n(1/t,1/o),t=Math.round(t/2),o=Math.round(o/2);this.compositeMaterial=this._getCompositeMaterial(this.nMips),this.compositeMaterial.uniforms.blurTexture1.value=this.renderTargetsVertical[0].texture,this.compositeMaterial.uniforms.blurTexture2.value=this.renderTargetsVertical[1].texture,this.compositeMaterial.uniforms.blurTexture3.value=this.renderTargetsVertical[2].texture,this.compositeMaterial.uniforms.blurTexture4.value=this.renderTargetsVertical[3].texture,this.compositeMaterial.uniforms.blurTexture5.value=this.renderTargetsVertical[4].texture,this.compositeMaterial.uniforms.bloomStrength.value=l,this.compositeMaterial.uniforms.bloomRadius.value=.1;const S=[1,.8,.6,.4,.2];this.compositeMaterial.uniforms.bloomFactors.value=S,this.bloomTintColors=[new m(1,1,1),new m(1,1,1),new m(1,1,1),new m(1,1,1),new m(1,1,1)],this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,this.copyUniforms=M.clone(b.uniforms),this.blendMaterial=new f({uniforms:this.copyUniforms,vertexShader:b.vertexShader,fragmentShader:b.fragmentShader,premultipliedAlpha:!0,blending:y,depthTest:!1,depthWrite:!1,transparent:!0}),this._oldClearColor=new v,this._oldClearAlpha=1,this._basic=new U,this._fsQuad=new P(null)}dispose(){for(let e=0;e<this.renderTargetsHorizontal.length;e++)this.renderTargetsHorizontal[e].dispose();for(let e=0;e<this.renderTargetsVertical.length;e++)this.renderTargetsVertical[e].dispose();this.renderTargetBright.dispose();for(let e=0;e<this.separableBlurMaterials.length;e++)this.separableBlurMaterials[e].dispose();this.compositeMaterial.dispose(),this.blendMaterial.dispose(),this._basic.dispose(),this._fsQuad.dispose()}setSize(e,l){let r=Math.round(e/2),i=Math.round(l/2);this.renderTargetBright.setSize(r,i);for(let t=0;t<this.nMips;t++)this.renderTargetsHorizontal[t].setSize(r,i),this.renderTargetsVertical[t].setSize(r,i),this.separableBlurMaterials[t].uniforms.invSize.value=new n(1/r,1/i),r=Math.round(r/2),i=Math.round(i/2)}render(e,l,r,i,t){e.getClearColor(this._oldClearColor),this._oldClearAlpha=e.getClearAlpha();const o=e.autoClear;e.autoClear=!1,e.setClearColor(this.clearColor,0),t&&e.state.buffers.stencil.setTest(!1),this.renderToScreen&&(this._fsQuad.material=this._basic,this._basic.map=r.texture,e.setRenderTarget(null),e.clear(),this._fsQuad.render(e)),this.highPassUniforms.tDiffuse.value=r.texture,this.highPassUniforms.luminosityThreshold.value=this.threshold,this._fsQuad.material=this.materialHighPassFilter,e.setRenderTarget(this.renderTargetBright),e.clear(),this._fsQuad.render(e);let u=this.renderTargetBright;for(let s=0;s<this.nMips;s++)this._fsQuad.material=this.separableBlurMaterials[s],this.separableBlurMaterials[s].uniforms.colorTexture.value=u.texture,this.separableBlurMaterials[s].uniforms.direction.value=h.BlurDirectionX,e.setRenderTarget(this.renderTargetsHorizontal[s]),e.clear(),this._fsQuad.render(e),this.separableBlurMaterials[s].uniforms.colorTexture.value=this.renderTargetsHorizontal[s].texture,this.separableBlurMaterials[s].uniforms.direction.value=h.BlurDirectionY,e.setRenderTarget(this.renderTargetsVertical[s]),e.clear(),this._fsQuad.render(e),u=this.renderTargetsVertical[s];this._fsQuad.material=this.compositeMaterial,this.compositeMaterial.uniforms.bloomStrength.value=this.strength,this.compositeMaterial.uniforms.bloomRadius.value=this.radius,this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,e.setRenderTarget(this.renderTargetsHorizontal[0]),e.clear(),this._fsQuad.render(e),this._fsQuad.material=this.blendMaterial,this.copyUniforms.tDiffuse.value=this.renderTargetsHorizontal[0].texture,t&&e.state.buffers.stencil.setTest(!0),this.renderToScreen?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(r),this._fsQuad.render(e)),e.setClearColor(this._oldClearColor,this._oldClearAlpha),e.autoClear=o}_getSeparableBlurMaterial(e){const l=[],r=e/3;for(let i=0;i<e;i++)l.push(.39894*Math.exp(-.5*i*i/(r*r))/r);return new f({defines:{KERNEL_RADIUS:e},uniforms:{colorTexture:{value:null},invSize:{value:new n(.5,.5)},direction:{value:new n(.5,.5)},gaussianCoefficients:{value:l}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				#include <common>

				varying vec2 vUv;

				uniform sampler2D colorTexture;
				uniform vec2 invSize;
				uniform vec2 direction;
				uniform float gaussianCoefficients[KERNEL_RADIUS];

				void main() {

					float weightSum = gaussianCoefficients[0];
					vec3 diffuseSum = texture2D( colorTexture, vUv ).rgb * weightSum;

					for ( int i = 1; i < KERNEL_RADIUS; i ++ ) {

						float x = float( i );
						float w = gaussianCoefficients[i];
						vec2 uvOffset = direction * invSize * x;
						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset ).rgb;
						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset ).rgb;
						diffuseSum += ( sample1 + sample2 ) * w;

					}

					gl_FragColor = vec4( diffuseSum, 1.0 );

				}`})}_getCompositeMaterial(e){return new f({defines:{NUM_MIPS:e},uniforms:{blurTexture1:{value:null},blurTexture2:{value:null},blurTexture3:{value:null},blurTexture4:{value:null},blurTexture5:{value:null},bloomStrength:{value:1},bloomFactors:{value:null},bloomTintColors:{value:null},bloomRadius:{value:0}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				varying vec2 vUv;

				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform float bloomStrength;
				uniform float bloomRadius;
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor( const in float factor ) {

					float mirrorFactor = 1.2 - factor;
					return mix( factor, mirrorFactor, bloomRadius );

				}

				void main() {

					// 3.0 for backwards compatibility with previous alpha-based intensity
					vec3 bloom = 3.0 * bloomStrength * (
						lerpBloomFactor( bloomFactors[ 0 ] ) * bloomTintColors[ 0 ] * texture2D( blurTexture1, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 1 ] ) * bloomTintColors[ 1 ] * texture2D( blurTexture2, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 2 ] ) * bloomTintColors[ 2 ] * texture2D( blurTexture3, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 3 ] ) * bloomTintColors[ 3 ] * texture2D( blurTexture4, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 4 ] ) * bloomTintColors[ 4 ] * texture2D( blurTexture5, vUv ).rgb
					);

					float bloomAlpha = max( bloom.r, max( bloom.g, bloom.b ) );
					gl_FragColor = vec4( bloom, bloomAlpha );

				}`})}}h.BlurDirectionX=new n(1,0),h.BlurDirectionY=new n(0,1);export{h as UnrealBloomPass};
//# sourceMappingURL=/sm/1a41b1c13296a87dd042ba40e8d280815a41ee1b403057ad6759e0391756ff44.map