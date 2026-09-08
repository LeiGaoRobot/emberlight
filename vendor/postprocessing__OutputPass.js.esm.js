/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/three@0.184.0/examples/jsm/postprocessing/OutputPass.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
import{OrthographicCamera as o,BufferGeometry as n,Float32BufferAttribute as a,Mesh as l,UniformsUtils as p,RawShaderMaterial as g,ColorManagement as u,SRGBTransfer as _,LinearToneMapping as f,ReinhardToneMapping as h,CineonToneMapping as m,ACESFilmicToneMapping as d,AgXToneMapping as M,NeutralToneMapping as c,CustomToneMapping as T}from"/npm/three@0.184.0/+esm";class C{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}const N=new o(-1,1,1,-1,0,1);class E extends n{constructor(){super(),this.setAttribute("position",new a([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new a([0,2,0,0,2,0],2))}}const P=new E;class A{constructor(e){this._mesh=new l(P,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,N)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}const i={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		precision highp float;

		uniform sampler2D tDiffuse;

		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#ifdef LINEAR_TONE_MAPPING

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( REINHARD_TONE_MAPPING )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );

			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_FILMIC_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#elif defined( AGX_TONE_MAPPING )

				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );

			#elif defined( NEUTRAL_TONE_MAPPING )

				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );

			#elif defined( CUSTOM_TONE_MAPPING )

				gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );

			#endif

			// color space

			#ifdef SRGB_TRANSFER

				gl_FragColor = sRGBTransferOETF( gl_FragColor );

			#endif

		}`};class S extends C{constructor(){super(),this.isOutputPass=!0,this.uniforms=p.clone(i.uniforms),this.material=new g({name:i.name,uniforms:this.uniforms,vertexShader:i.vertexShader,fragmentShader:i.fragmentShader}),this._fsQuad=new A(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,r,s){this.uniforms.tDiffuse.value=s.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,(this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping)&&(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},u.getTransfer(this._outputColorSpace)===_&&(this.material.defines.SRGB_TRANSFER=""),this._toneMapping===f?this.material.defines.LINEAR_TONE_MAPPING="":this._toneMapping===h?this.material.defines.REINHARD_TONE_MAPPING="":this._toneMapping===m?this.material.defines.CINEON_TONE_MAPPING="":this._toneMapping===d?this.material.defines.ACES_FILMIC_TONE_MAPPING="":this._toneMapping===M?this.material.defines.AGX_TONE_MAPPING="":this._toneMapping===c?this.material.defines.NEUTRAL_TONE_MAPPING="":this._toneMapping===T&&(this.material.defines.CUSTOM_TONE_MAPPING=""),this.material.needsUpdate=!0),this.renderToScreen===!0?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(r),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}}export{S as OutputPass};
//# sourceMappingURL=/sm/43cad7d1d6301c3640758e74379550d05763e390df9fa0a7e2d4901ddf8377aa.map