import maplibregl from "maplibre-gl"
import type { ReachLine } from "./reach/codec.ts"

const VERT = `
attribute vec2 a_corner;
attribute vec2 a_a;
attribute vec2 a_b;
attribute vec2 a_t;
uniform mat4 u_matrix;
uniform vec2 u_screen;
uniform float u_width;
uniform float u_world;
varying float v_time;
varying float v_side;
void main() {
  vec4 ca = u_matrix * vec4(a_a * u_world, 0.0, 1.0);
  vec4 cb = u_matrix * vec4(a_b * u_world, 0.0, 1.0);
  vec2 sa = ca.xy / ca.w;
  vec2 sb = cb.xy / cb.w;
  vec2 screenDir = vec2((sb.x - sa.x) * u_screen.x * 0.5, (sb.y - sa.y) * u_screen.y * 0.5);
  float slen = length(screenDir);
  vec2 screenNormal = slen > 0.001 ? vec2(-screenDir.y, screenDir.x) / slen : vec2(0.0, 1.0);
  vec2 screenAlong = slen > 0.001 ? screenDir / slen : vec2(1.0, 0.0);
  vec2 px = screenNormal * a_corner.y * u_width + screenAlong * (a_corner.x - 0.5) * u_width;
  vec2 ndc = mix(sa, sb, a_corner.x) + vec2(px.x / u_screen.x * 2.0, px.y / u_screen.y * 2.0);
  float w = mix(ca.w, cb.w, a_corner.x);
  gl_Position = vec4(ndc * w, mix(ca.z, cb.z, a_corner.x), w);
  v_time = mix(a_t.x, a_t.y, a_corner.x);
  v_side = a_corner.y;
}
`

const FRAG = `
precision mediump float;
varying float v_time;
varying float v_side;
uniform float u_time;
uniform float u_b1;
uniform float u_b2;
uniform float u_alpha;
uniform float u_core;
void main() {
  if (u_time < 0.0) discard;
  float aa = 1.4;
  float front = 1.0 - smoothstep(u_time - aa, u_time + aa, v_time);
  if (front <= 0.001) discard;
  float edge = 1.0 - smoothstep(0.45, 1.0, abs(v_side));
  vec3 gold = vec3(1.0, 0.784, 0.341);
  vec3 coral = vec3(1.0, 0.420, 0.239);
  vec3 blue = vec3(0.494, 0.714, 1.0);
  vec3 band = v_time < u_b1 ? gold : v_time < u_b2 ? coral : blue;
  float lead = smoothstep(u_time - 3.0, u_time, v_time);
  vec3 color = mix(band, vec3(1.0, 0.97, 0.92), u_core * (0.45 + lead * 0.4));
  float alpha = u_alpha * edge * front;
  gl_FragColor = vec4(color * alpha, alpha);
}
`

const CORNERS: Array<[number, number]> = [
  [0, -1],
  [1, -1],
  [0, 1],
  [0, 1],
  [1, -1],
  [1, 1],
]

export type FuseHandle = {
  setLines(lines: ReachLine[]): void
  setClock(seconds: number, band1: number, band2: number): void
  setWidthScale(scale: number): void
}

export function createFuseLayer(map: maplibregl.Map): maplibregl.CustomLayerInterface & FuseHandle {
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
  let program: WebGLProgram | null = null
  let buffer: WebGLBuffer | null = null
  let vertexCount = 0
  let seconds = -1
  let band1 = 300
  let band2 = 600
  let widthScale = 1
  const locs: Record<string, WebGLUniformLocation | null> = {}
  const attrs: Record<string, number> = {}

  const layer: maplibregl.CustomLayerInterface & FuseHandle = {
    id: "fuse",
    type: "custom",
    renderingMode: "2d",
    onAdd(_map, context) {
      gl = context
      program = buildProgram(context)
      for (const name of ["u_matrix", "u_screen", "u_width", "u_world", "u_time", "u_b1", "u_b2", "u_alpha", "u_core"]) {
        locs[name] = context.getUniformLocation(program, name)
      }
      for (const name of ["a_corner", "a_a", "a_b", "a_t"]) attrs[name] = context.getAttribLocation(program, name)
      buffer = context.createBuffer()
    },
    onRemove(_map, context) {
      if (program) context.deleteProgram(program)
      if (buffer) context.deleteBuffer(buffer)
      gl = null
    },
    setLines(lines) {
      const built = segmentsFromLines(lines)
      vertexCount = built.vertexCount
      const context = gl
      if (!context || !buffer) return
      context.bindBuffer(context.ARRAY_BUFFER, buffer)
      context.bufferData(context.ARRAY_BUFFER, built.data, context.STATIC_DRAW)
      map.triggerRepaint()
    },
    setClock(next, b1, b2) {
      seconds = next
      band1 = b1
      band2 = b2
    },
    setWidthScale(scale) {
      widthScale = scale
    },
    render(context, options) {
      if (!program || !buffer || vertexCount === 0 || seconds < 0) return
      context.useProgram(program)
      context.enable(context.BLEND)
      context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA)
      context.disable(context.DEPTH_TEST)
      const matrix = options.modelViewProjectionMatrix
      context.uniformMatrix4fv(
        locs.u_matrix ?? null,
        false,
        matrix instanceof Float32Array ? matrix : Float32Array.from(matrix as ArrayLike<number>),
      )
      context.uniform2f(locs.u_screen ?? null, context.drawingBufferWidth, context.drawingBufferHeight)
      context.uniform1f(locs.u_world ?? null, map.transform.worldSize)
      context.uniform1f(locs.u_time ?? null, seconds)
      context.uniform1f(locs.u_b1 ?? null, band1)
      context.uniform1f(locs.u_b2 ?? null, band2)
      const dpr = context.drawingBufferWidth / Math.max(1, map.getCanvas().clientWidth)
      const zoom = map.getZoom()
      const px = (zoom < 11 ? 2.2 : zoom < 13 ? 2.8 : zoom < 15 ? 3.6 : 4.8) * dpr * widthScale
      context.bindBuffer(context.ARRAY_BUFFER, buffer)
      const stride = 32
      const bind = (name: string, size: number, offset: number) => {
        const loc = attrs[name] ?? -1
        if (loc < 0) return
        context.enableVertexAttribArray(loc)
        context.vertexAttribPointer(loc, size, context.FLOAT, false, stride, offset)
      }
      bind("a_a", 2, 0)
      bind("a_b", 2, 8)
      bind("a_t", 2, 16)
      bind("a_corner", 2, 24)
      context.uniform1f(locs.u_width ?? null, px * 3.2)
      context.uniform1f(locs.u_alpha ?? null, 0.45)
      context.uniform1f(locs.u_core ?? null, 0)
      context.drawArrays(context.TRIANGLES, 0, vertexCount)
      context.uniform1f(locs.u_width ?? null, px)
      context.uniform1f(locs.u_alpha ?? null, 0.95)
      context.uniform1f(locs.u_core ?? null, 1)
      context.drawArrays(context.TRIANGLES, 0, vertexCount)
    },
  }

  return layer
}

function segmentsFromLines(lines: ReachLine[]): { data: Float32Array; vertexCount: number } {
  let segments = 0
  for (const line of lines) segments += Math.max(0, line.lon.length - 1)
  const data = new Float32Array(Math.max(1, segments) * 6 * 8)
  let vertex = 0
  for (const line of lines) {
    let ax = 0
    let ay = 0
    let started = false
    for (let i = 0; i < line.lon.length; i++) {
      const coord = maplibregl.MercatorCoordinate.fromLngLat({ lng: line.lon[i] ?? 0, lat: line.lat[i] ?? 0 })
      if (started) {
        const t0 = line.t[i - 1] ?? 0
        const t1 = line.t[i] ?? 0
        for (const corner of CORNERS) {
          const base = vertex * 8
          data[base] = ax
          data[base + 1] = ay
          data[base + 2] = coord.x
          data[base + 3] = coord.y
          data[base + 4] = t0
          data[base + 5] = t1
          data[base + 6] = corner[0]
          data[base + 7] = corner[1]
          vertex += 1
        }
      }
      ax = coord.x
      ay = coord.y
      started = true
    }
  }
  return { data: vertex === segments * 6 ? data : data.slice(0, vertex * 8), vertexCount: vertex }
}

function buildProgram(gl: WebGLRenderingContext): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error("Could not create the street shader")
  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Street shader failed to link")
  }
  return program
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error("Could not create a shader")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Shader failed to compile")
  }
  return shader
}
