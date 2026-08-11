import { ComponentProps } from "solid-js"

const W_OUTLINE_512 =
  "0,256 51,205 154,307 256,205 358,307 461,205 512,256 461,307 358,410 256,307 154,410 51,307"

const DIAMONDS_512 = [
  "256,0 307,51 256,102 205,51",
  "154,102 205,154 154,205 102,154",
  "358,102 410,154 358,205 307,154",
  "256,410 307,461 256,512 205,461",
] as const

function scalePoints(pts: string, k: number) {
  return pts
    .trim()
    .split(/\s+/)
    .map((p) => {
      const [x, y] = p.split(",").map(Number)
      return `${Math.round(x * k)},${Math.round(y * k)}`
    })
    .join(" ")
}

const W_OUTLINE_1024 = scalePoints(W_OUTLINE_512, 2)
const DIAMONDS_1024 = DIAMONDS_512.map((d) => scalePoints(d, 2))

/** Logo 小图标区：原矢量约占 154px 高，将 512 稿整体缩放落入该区域 */
const LOGO_ICON_SCALE = 154 / 512

/** glyph（W + 4 颗菱形）相对 squircle 占比，参考 packages/desktop/icons/README.md */
const GLYPH_SCALE = 0.75
const GLYPH_INSET_512 = ((1 - GLYPH_SCALE) / 2) * 512
const GLYPH_INSET_1024 = ((1 - GLYPH_SCALE) / 2) * 1024

export const WanlaiMark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      shape-rendering="geometricPrecision"
    >
      <rect data-slot="logo-mark-bg" x="0" y="0" width="512" height="512" rx="110" fill="#14161C" />
      <g transform={`translate(${GLYPH_INSET_512} ${GLYPH_INSET_512}) scale(${GLYPH_SCALE})`}>
        <polygon data-slot="logo-mark-w" points={W_OUTLINE_512} fill="#F0C419" fill-rule="evenodd" />
        <polygon data-slot="logo-mark-top" points={DIAMONDS_512[0]} fill="#F0C419" />
        <polygon data-slot="logo-mark-left" points={DIAMONDS_512[1]} fill="#F0C419" />
        <polygon data-slot="logo-mark-right" points={DIAMONDS_512[2]} fill="#F0C419" />
        <polygon data-slot="logo-mark-bottom" points={DIAMONDS_512[3]} fill="#F0C419" />
      </g>
    </svg>
  )
}

/** Mark 灰色版本：跟随主题文字颜色，无背景 */
export const WanlaiMarkGray = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark-gray"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      shape-rendering="geometricPrecision"
    >
      <g transform={`translate(${GLYPH_INSET_512} ${GLYPH_INSET_512}) scale(${GLYPH_SCALE})`}>
        <polygon data-slot="logo-mark-w" points={W_OUTLINE_512} fill="currentColor" fill-rule="evenodd" />
        <polygon data-slot="logo-mark-top" points={DIAMONDS_512[0]} fill="currentColor" />
        <polygon data-slot="logo-mark-left" points={DIAMONDS_512[1]} fill="currentColor" />
        <polygon data-slot="logo-mark-right" points={DIAMONDS_512[2]} fill="currentColor" />
        <polygon data-slot="logo-mark-bottom" points={DIAMONDS_512[3]} fill="currentColor" />
      </g>
    </svg>
  )
}

export const WanlaiSplash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect data-slot="logo-bg" x="0" y="0" width="1024" height="1024" rx="220" fill="#14161C" />
      <g transform={`translate(${GLYPH_INSET_1024} ${GLYPH_INSET_1024}) scale(${GLYPH_SCALE})`}>
        <polygon data-slot="logo-w" points={W_OUTLINE_1024} fill={"var(--logo-glyph, #F0C419)"} fill-rule="evenodd" />
        <polygon data-slot="logo-top" points={DIAMONDS_1024[0]} fill={"var(--logo-glyph, #F0C419)"} />
        <polygon data-slot="logo-left" points={DIAMONDS_1024[1]} fill={"var(--logo-glyph, #F0C419)"} />
        <polygon data-slot="logo-right" points={DIAMONDS_1024[2]} fill={"var(--logo-glyph, #F0C419)"} />
        <polygon data-slot="logo-bottom" points={DIAMONDS_1024[3]} fill={"var(--logo-glyph, #F0C419)"} />
      </g>
    </svg>
  )
}

export const WanlaiLogo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 520 560"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform={`translate(156 16) scale(${LOGO_ICON_SCALE})`}>
        <polygon data-slot="logo-icon-w" points={W_OUTLINE_512} fill={"var(--logo-glyph, #F0C419)"} fill-rule="evenodd" />
        <polygon points={DIAMONDS_512[0]} fill={"var(--logo-glyph, #F0C419)"} />
        <polygon points={DIAMONDS_512[1]} fill={"var(--logo-glyph, #F0C419)"} />
        <polygon points={DIAMONDS_512[2]} fill={"var(--logo-glyph, #F0C419)"} />
        <polygon points={DIAMONDS_512[3]} fill={"var(--logo-glyph, #F0C419)"} />
      </g>
      <g transform="translate(104 210)">
        <g transform="scale(0.23)">
          <g transform="translate(-1890 -1343)">
            <path
              d="M1826.01,1397.21q0,27.075-1.21,46.77t-3.38,33.59a130.222,130.222,0,0,1-5.2,22.47,56.3,56.3,0,0,1-6.52,13.54q-3.51,4.95-7.5,6.64a19.908,19.908,0,0,1-7.85,1.69h-9.91v32.15h12.09q14.01,0,24.52-5.44t18.13-18.01q7.6-12.555,12.2-33.35,4.59-20.775,6.53-51.23h88.69v62.59q0,8.22-4.23,13.54t-14.86,10.39l17.64,27.31a104.265,104.265,0,0,0,17.4-10.15,45.206,45.206,0,0,0,10.51-10.64,33.3,33.3,0,0,0,5.08-12.08,74.63,74.63,0,0,0,1.33-14.74v-72.74q0-10.635-6.41-16.8t-16.31-6.65h-97.63c0-3.86.03-7.81,0.12-11.84s0.12-8.21,0.12-12.56v-11.12H1998.8v-29.97H1790v29.97h36.01v16.67Zm303.77,156.85h31.42v-87.97h91.11v-28.76h-50.27q7.26-8.2,14.74-17.52,7.5-9.3,13.05-16.31l-13.77-11.36h26.1v-28.76H2161.2v-20.54h-31.42v20.54h-79.02v28.76h25.86l-14.5,12.08q2.415,2.91,5.68,6.77t7,8.22q3.75,4.35,7.62,9.06,3.855,4.71,7.49,9.06h-49.78v28.76h89.65v87.97Zm84.35-79.75h-31.18v10.15a98.664,98.664,0,0,0,3.63,27.67,52.764,52.764,0,0,0,11.84,21.38,54.787,54.787,0,0,0,21.02,13.9q12.81,4.95,31.42,4.95h5.56V1522.4h-6.77q-18.375,0-26.95-9.55t-8.57-27.91v-10.63ZM2080,1484.94q0,18.375-8.7,27.91-8.7,9.555-27.07,9.55h-6.76v29.96h5.56q17.4,0,30.2-4.95a56.7,56.7,0,0,0,21.15-13.77,56.054,56.054,0,0,0,12.45-21.39,89.329,89.329,0,0,0,4.1-27.79v-10.15H2080v10.63Zm105.61-47.61H2161.2v-45.19h39.63q-6.285,8.22-14.13,17.4t-14.38,15.71Zm-66.46-13.05-27.55-32.14h38.18v45.19h-25.85Z"
              fill="currentColor"
            />
            <path
              d="M2338.43,1555.38h114.26v-29.61H2349.4V1415.02h103.29v-29.61H2338.43a24.346,24.346,0,0,0-24.12,24.56v120.84a24.346,24.346,0,0,0,24.12,24.57h0Zm266.47-30.71v-64.26a33.889,33.889,0,0,0-7.02-21.49q-7.02-8.985-17.11-8.99h-76.98q-10.08,0-17.32,8.99a33.159,33.159,0,0,0-7.46,21.49v64.26q0,12.72,7.46,21.5,7.665,8.985,17.32,8.99h76.98q9.87,0,17.11-8.99,7.02-8.565,7.02-21.5h0Zm-91.9-67.98h57.9v71.71H2513v-71.71Zm121.28,6.79v64.92a27.918,27.918,0,0,0,7.02,18.86,21.213,21.213,0,0,0,17.11,7.9h98.69l0.22-169.97h-34v51.54h-64.91q-9.87,0-17.11,7.89a26.931,26.931,0,0,0-7.02,18.86h0Zm34,65.36v-65.79h54.82v65.79h-54.82Zm232.47-91.12a22,22,0,0,0-17.33-7.79h-70.84q-9.87,0-17.1,8.99a33.889,33.889,0,0,0-7.02,21.49v64.26q0,12.51,7.02,21.5,7.23,8.985,17.1,8.99h95.18v-26.32h-85.31v-22.81h60.97a22,22,0,0,0,17.33-7.78q6.8-7.785,6.8-20.07v-20.4Q2907.55,1445.51,2900.75,1437.72Zm-27.2,18.53v23.46h-51.1v-23.46h51.1Z"
              fill="currentColor"
            />
          </g>
        </g>
      </g>
    </svg>
  )
}
