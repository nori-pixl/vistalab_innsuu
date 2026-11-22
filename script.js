// HTML 上の主要な要素を取得
// ベンチマーク開始ボタン、ログ表示エリア、各表示欄を参照する
const startBenchmark = document.getElementById("start-benchmark");
const log = document.getElementById("log");

const displaySingleScore = document.getElementById("display-single-score");
const displayMultiScore = document.getElementById("display-multi-score");
const displayGpuScore = document.getElementById("display-gpu-score");
const gpuHexLabel = document.getElementById("gpu-hex");

const gpuSizeInput = document.getElementById("gpu-size");
const gpuSizeLabel = document.getElementById("gpu-size-label");
const gpuPixelsLabel = document.getElementById("gpu-pixels-label");

const shareToTwitter = document.getElementById("share-to-twitter");
let latestResult = null;

// ベンチマークで使う定数
// 対象の数値は素因数分解の負荷をかけるための固定値
const FACTORIZATION_TARGET = 1145141919810364364;
const BENCHMARK_DURATION_MS = 10_000;

// 利用可能な CPU コア数を基に、マルチスレッド側のワーカー数を決定する
// ただし最低 2 つは使うようにする
const MULTI_WORKER_COUNT = Math.max(2, navigator.hardwareConcurrency || 4);

// GPU の処理サイズ（N × N ピクセル = 1 回の描画で N×N 回ぶん同時に処理）
const GPU_SIZE_DEFAULT = 130;
const GPU_SIZE_MIN = 8;
const GPU_SIZE_MAX = 1024;
const GPU_SIZE_KEY = "bench_gpu_size";

// 指定された数値の素因数分解を行い、因数の配列を返す
// 例: 12 => [2, 2, 3]
function primeFactorization(num) {
  const factors = [];
  let divisor = 2;

  while (divisor * divisor <= num) {
    while (num % divisor === 0) {
      factors.push(divisor);
      num /= divisor;
    }
    divisor++;
  }

  if (num > 1) {
    factors.push(num);
  }

  return factors;
}

// ログ表示欄にメッセージを出す
function updateLog(message) {
  log.textContent = message;
}

// UI の更新を最優先にするため、次のフレームまで待機させる
function waitForUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// シングルスレッドでベンチマークを実行する
async function runSingleBenchmark() {
  const deadline = performance.now() + BENCHMARK_DURATION_MS;
  let count = 0;

  while (performance.now() < deadline) {
    for (let i = 0; i < 1000 && performance.now() < deadline; i++) {
      primeFactorization(FACTORIZATION_TARGET);
      count++;
    }
    updateLog(`シングル計測中: ${count.toLocaleString()} 回`);
    await waitForUi();
  }

  return count;
}

// Worker 用のソースコードを Blob から生成する
// Web Worker 内で同じ素因数分解を実行できるようにするため
function createBenchmarkWorkerUrl() {
  const workerSource = `
${primeFactorization.toString()}

self.onmessage = (event) => {
  const { duration, target } = event.data;
  const deadline = performance.now() + duration;
  let count = 0;

  while (performance.now() < deadline) {
    primeFactorization(target);
    count++;
  }

  self.postMessage({ count });
};
`;

  return URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
}

// 1 つの Worker に対してベンチマークを実行する
function runWorkerBenchmark(workerUrl) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);

    worker.onmessage = (event) => {
      worker.terminate();
      resolve(event.data.count);
    };

    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Worker benchmark failed"));
    };

    worker.postMessage({ duration: BENCHMARK_DURATION_MS, target: FACTORIZATION_TARGET });
  });
}

// マルチスレッドでベンチマークを実行する
// CPU コア数ごとに分割して並列処理を行う
async function runMultiBenchmark() {
  if (typeof Worker === "undefined") {
    throw new Error("このブラウザは Web Worker に対応していません");
  }

  const workerUrl = createBenchmarkWorkerUrl();
  let completedWorkers = 0;

  const tasks = Array.from({ length: MULTI_WORKER_COUNT }, (_, index) => {
    return runWorkerBenchmark(workerUrl).then((count) => {
      completedWorkers++;
      updateLog(`マルチ: ${completedWorkers} / ${MULTI_WORKER_COUNT} workers`);
      return count;
    });
  });

  try {
    const results = await Promise.all(tasks);
    return results.reduce((total, count) => total + count, 0);
  } finally {
    // Blob URL は使い終わったら破棄する
    URL.revokeObjectURL(workerUrl);
  }
}

/* ================================================================
 * GPU ベンチマーク（WebGL2）
 * WebGPU の計算シェーダ（canvas なし）で素因数分解を行い、結果の HEX 文字を CPU の答えと照合する。
 * 1 スレッド = 1 回の素因数分解。WebGPU が使えない環境は WebGL2 で代替する。
 * ================================================================ */
function loadGpuSize() {
  let saved = null;
  try { saved = localStorage.getItem(GPU_SIZE_KEY); } catch (e) { /* 保存できない環境 */ }
  gpuSizeInput.value = saved || String(GPU_SIZE_DEFAULT);
  refreshGpuSizeLabel();
}

function getGpuSize() {
  let n = parseInt(gpuSizeInput.value, 10);
  if (!Number.isFinite(n)) n = GPU_SIZE_DEFAULT;
  return Math.min(GPU_SIZE_MAX, Math.max(GPU_SIZE_MIN, n));
}

function refreshGpuSizeLabel() {
  const n = getGpuSize();
  gpuSizeLabel.textContent = String(n);
  gpuPixelsLabel.textContent = (n * n).toLocaleString();
}

gpuSizeInput.addEventListener("input", refreshGpuSizeLabel);
gpuSizeInput.addEventListener("change", () => {
  const n = getGpuSize();
  gpuSizeInput.value = String(n);
  try { localStorage.setItem(GPU_SIZE_KEY, String(n)); } catch (e) { /* 保存できない環境 */ }
  refreshGpuSizeLabel();
});

const gpuBench = (function () {
  /* WebGPU compute を優先（canvas を使わず、計算シェーダ → ストレージバッファ → 読み出し）。
     使えない環境では WebGL2（画面に置かない OffscreenCanvas）に自動で切り替える。
     どちらも pass(hi, lo) は size×size 個ぶんの結果（最大の素因数、32bit整数）の配列を返す */
  const COMPUTE_WGSL = `
struct P { hi:u32, lo:u32, cnt:u32, z:u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> outd: array<u32>;
fn modn(hi:u32, lo:u32, d:u32) -> u32 {
  var r = 0u;
  for (var b = 31; b >= 0; b--) { r = (r << 1u) | ((hi >> u32(b)) & 1u); if (r >= d) { r -= d; } }
  for (var b = 31; b >= 0; b--) { r = (r << 1u) | ((lo >> u32(b)) & 1u); if (r >= d) { r -= d; } }
  return r;
}
fn divn(hi:u32, lo:u32, d:u32) -> vec2<u32> {
  var qh = 0u; var ql = 0u; var r = 0u;
  for (var b = 31; b >= 0; b--) { r = (r << 1u) | ((hi >> u32(b)) & 1u); if (r >= d) { r -= d; qh |= (1u << u32(b)); } }
  for (var b = 31; b >= 0; b--) { r = (r << 1u) | ((lo >> u32(b)) & 1u); if (r >= d) { r -= d; ql |= (1u << u32(b)); } }
  return vec2<u32>(qh, ql);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.cnt) { return; }
  var hi = p.hi; var lo = p.lo; var big = 0u;
  for (var i = 0; i < 64; i++) { if ((lo & 1u) != 0u) { break; } lo = (lo >> 1u) | (hi << 31u); hi >>= 1u; big = 2u; }
  var d = 3u; var done = false;
  for (var it = 0; it < 32768; it++) {
    if (hi == 0u && d * d > lo) { done = true; break; }
    for (var k = 0; k < 64; k++) {
      if (modn(hi, lo, d) != 0u) { break; }
      let q = divn(hi, lo, d); hi = q.x; lo = q.y; big = d;
    }
    d += 2u;
  }
  var res = 0u;
  if (done) { if (hi == 0u && lo > 1u) { res = lo; } else { res = big; } }
  outd[g.x] = res;
}`;

  let mode = null, failed = false, size = 0;

  /* ---- WebGPU ---- */
  let dev = null, pipe = null, bgl = null, parB = null, outB = null, stage = null, bg = null, devLost = false;
  async function openWebGPU() {
    try {
      if (!navigator.gpu) return false;
      const ad = await navigator.gpu.requestAdapter();
      if (!ad) return false;
      dev = await ad.requestDevice();
      dev.lost.then(() => { devLost = true; });
      const V = GPUShaderStage.COMPUTE;
      bgl = dev.createBindGroupLayout({ entries: [
        { binding: 0, visibility: V, buffer: { type: "uniform" } },
        { binding: 1, visibility: V, buffer: { type: "storage" } }
      ] });
      pipe = await dev.createComputePipelineAsync({   // シェーダに問題があればここで失敗 → WebGL2へ切り替え
        layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        compute: { module: dev.createShaderModule({ code: COMPUTE_WGSL }), entryPoint: "main" }
      });
      parB = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      return true;
    } catch (e) { console.error("[webgpu]", e); dev = null; return false; }
  }
  function sizeWebGPU(n) {
    const lim = Math.floor(Math.sqrt(Math.min(dev.limits.maxStorageBufferBindingSize, dev.limits.maxBufferSize) / 4));
    n = Math.max(1, Math.min(n, lim));
    if (n !== size) {
      size = n;
      if (outB) { outB.destroy(); stage.destroy(); }
      const B = GPUBufferUsage, bytes = n * n * 4;
      outB = dev.createBuffer({ size: bytes, usage: B.STORAGE | B.COPY_SRC });
      stage = dev.createBuffer({ size: bytes, usage: B.MAP_READ | B.COPY_DST });
      bg = dev.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: parB } }, { binding: 1, resource: { buffer: outB } }] });
    }
    return true;
  }
  async function passWebGPU(hi, lo) {
    const cnt = size * size;
    dev.queue.writeBuffer(parB, 0, new Uint32Array([hi, lo, cnt, 0]));
    const enc = dev.createCommandEncoder(), pl = enc.beginComputePass();
    pl.setPipeline(pipe); pl.setBindGroup(0, bg); pl.dispatchWorkgroups(Math.ceil(cnt / 64)); pl.end();
    enc.copyBufferToBuffer(outB, 0, stage, 0, cnt * 4);
    dev.queue.submit([enc.finish()]);
    await stage.mapAsync(GPUMapMode.READ, 0, cnt * 4);   // GPUの完了を待つ（メインスレッドは止めない）
    const out = new Uint32Array(stage.getMappedRange(0, cnt * 4).slice(0));
    stage.unmap();
    return out;
  }

  /* ---- WebGL2（フォールバック）：結果を色(RGBA)として描き、readPixels で読む ---- */
  let gl = null, prog = null, U = {}, tex = null, fbo = null;
  const VS = "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";
  // N（64bit を hi/lo の 2 つの 32bit に分けたもの）を 3,5,7,... で試し割りして、最大の素因数を色(RGBA)として返す
  const FS = "#version 300 es\n" +
    "precision highp float;precision highp int;uniform uint uhi,ulo;out vec4 o;\n" +
    "uint modn(uint hi,uint lo,uint d){uint r=0u;\n" +
    "for(int b=31;b>=0;b--){r=(r<<1)|((hi>>uint(b))&1u);if(r>=d)r-=d;}\n" +
    "for(int b=31;b>=0;b--){r=(r<<1)|((lo>>uint(b))&1u);if(r>=d)r-=d;}\n" +
    "return r;}\n" +
    "void divn(inout uint hi,inout uint lo,uint d){uint qh=0u,ql=0u,r=0u;\n" +
    "for(int b=31;b>=0;b--){r=(r<<1)|((hi>>uint(b))&1u);if(r>=d){r-=d;qh|=(1u<<uint(b));}}\n" +
    "for(int b=31;b>=0;b--){r=(r<<1)|((lo>>uint(b))&1u);if(r>=d){r-=d;ql|=(1u<<uint(b));}}\n" +
    "hi=qh;lo=ql;}\n" +
    "void main(){uint hi=uhi,lo=ulo,big=0u;\n" +
    "for(int i=0;i<64;i++){if((lo&1u)!=0u)break;lo=(lo>>1)|(hi<<31);hi>>=1;big=2u;}\n" +
    "uint d=3u;bool done=false;\n" +
    "for(int it=0;it<32768;it++){\n" +
    "if(hi==0u&&d*d>lo){done=true;break;}\n" +
    "for(int k=0;k<64;k++){if(modn(hi,lo,d)!=0u)break;divn(hi,lo,d);big=d;}\n" +
    "d+=2u;}\n" +
    "uint res=0u;\n" +
    "if(done){res=(hi==0u&&lo>1u)?lo:big;}\n" +   // 残りが 1 より大きければ、それが最大の素因数
    "o=vec4(float(res>>24),float((res>>16)&255u),float((res>>8)&255u),float(res&255u))/255.0;}";
  function openGL() {
    try {
      let canvas;   // DOM には置かない（OffscreenCanvas。非対応なら未接続の canvas）
      try { canvas = new OffscreenCanvas(1, 1); } catch (e) { canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; }
      gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false });
      if (!gl) return false;
      const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      U = { hi: gl.getUniformLocation(prog, "uhi"), lo: gl.getUniformLocation(prog, "ulo") };
      tex = gl.createTexture();
      fbo = gl.createFramebuffer();
      gl.disable(gl.BLEND);
      gl.disable(gl.DITHER);
      gl.useProgram(prog);
      return true;
    } catch (e) { console.error("[gpu]", e); gl = null; return false; }
  }
  function sizeGL(n) {
    const n2 = Math.min(n, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    if (size !== n2) {
      size = n2;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
      gl.viewport(0, 0, size, size);
    }
    return true;
  }
  async function passGL(hi, lo) {
    gl.uniform1ui(U.hi, hi);
    gl.uniform1ui(U.lo, lo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new Uint32Array(size * size);   // 色(RGBA)のバイト列 → 32bit整数
    for (let i = 0; i < out.length; i++) { const q = i * 4; out[i] = ((px[q] << 24) | (px[q + 1] << 16) | (px[q + 2] << 8) | px[q + 3]) >>> 0; }
    return out;
  }

  async function init(n) {
    if (!mode) {
      if (failed) return false;
      if (await openWebGPU()) mode = "webgpu";
      else if (openGL()) mode = "webgl2";
      else { failed = true; return false; }
    }
    return mode === "webgpu" ? sizeWebGPU(n) : sizeGL(n);
  }
  // 1 回の実行 = size × size 回ぶんの素因数分解。結果（最大の素因数）を Uint32Array で返す
  function pass(hi, lo) { return mode === "webgpu" ? passWebGPU(hi, lo) : passGL(hi, lo); }

  return {
    init, pass,
    get size() { return size; },
    get name() { return mode === "webgpu" ? "WebGPU compute" : "WebGL2"; },
    get lost() { return mode === "webgpu" ? devLost : (!gl || gl.isContextLost()); }
  };
})();

// 32bit整数を 8 桁の HEX 文字にする
function u32ToHex(v) { return (v >>> 0).toString(16).padStart(8, "0").toUpperCase(); }

async function runGpuBenchmark() {
  if (!(await gpuBench.init(getGpuSize()))) {
    throw new Error("このブラウザでは WebGPU も WebGL2 も使えません");
  }

  const N = BigInt(FACTORIZATION_TARGET);
  if (N >= (1n << 62n)) throw new Error("GPU 計測は 2^62 未満の数に対応しています");
  const hi = Number(N >> 32n);
  const lo = Number(N & 0xFFFFFFFFn);
  const expected = Math.max(...primeFactorization(FACTORIZATION_TARGET));   // CPU で求めた最大の素因数（検算用）
  const expectedHex = u32ToHex(expected);
  const pixels = gpuBench.size * gpuBench.size;

  // 準備運動: シェーダのコンパイルなどが計測に入らないよう、先に 1 回だけ空打ちする
  await gpuBench.pass(hi, lo);

  const deadline = performance.now() + BENCHMARK_DURATION_MS;
  let count = 0;
  let lastHex = "";

  while (performance.now() < deadline) {
    if (gpuBench.lost) throw new Error("GPU のコンテキストが失われました");
    const res = await gpuBench.pass(hi, lo);
    const finishedInTime = performance.now() <= deadline;   // 時間内に終わった回だけ数える

    let ok = 0, wrong = 0;
    for (let i = 0; i < res.length; i++) {
      if (res[i] === expected) ok++;     // CPU の答えと一致したものだけ成功
      else wrong = res[i];
    }
    lastHex = u32ToHex(ok === pixels ? expected : wrong);
    if (ok !== pixels) {
      throw new Error(`GPU の結果が一致しません（期待 #${expectedHex} / 実際 #${lastHex}）`);
    }
    if (finishedInTime) count += ok;

    updateLog(`GPU計測中（${gpuBench.name}）: ${count.toLocaleString()} 回（最後のHEX #${lastHex}）`);
    gpuHexLabel.textContent = `GPUの結果HEX: #${lastHex}（最大の素因数 ${parseInt(lastHex, 16).toLocaleString()}）［${gpuBench.name}］`;
    await waitForUi();
  }

  return count;
}

// 「開始」ボタンを押したときの処理
startBenchmark.addEventListener("click", async () => {
  startBenchmark.disabled = true;
  shareToTwitter.disabled = true;
  latestResult = null;

  try {
    updateLog("シングル計測を開始中...");
    const singleCount = await runSingleBenchmark();
    displaySingleScore.textContent = singleCount.toLocaleString();
    // 以降の計測が、ホスティング環境の制限などで失敗しても、完了した結果は共有できる
    latestResult = { singleCount, multiCount: null, gpuCount: null };

    updateLog("マルチ計測中...");
    await waitForUi();
    const multiCount = await runMultiBenchmark();
    displayMultiScore.textContent = multiCount.toLocaleString();
    latestResult.multiCount = multiCount;

    updateLog("GPU計測中...");
    await waitForUi();
    try {
      const gpuCount = await runGpuBenchmark();
      displayGpuScore.textContent = gpuCount.toLocaleString();
      latestResult.gpuCount = gpuCount;
      updateLog("終了！");
    } catch (gpuError) {
      // GPU だけ失敗した場合も、シングル・マルチの結果は残す
      updateLog(`GPU計測に失敗しました: ${gpuError.message}`);
    }
  } catch (error) {
    updateLog(`計測に失敗しました: ${error.message}`);
  } finally {
    shareToTwitter.disabled = latestResult === null;
    // 二重実行防止のため、終了時にボタンを再度有効化する
    startBenchmark.disabled = false;
  }
});

shareToTwitter.addEventListener("click", () => {
  if (!latestResult) return;

  const { singleCount, multiCount, gpuCount } = latestResult;
  const lines = [
    "素因数分解ベンチマークの結果（10秒間）",
    `・シングル: ${singleCount.toLocaleString()}回`,
  ];
  if (multiCount !== null) {
    lines.push(`・マルチ: ${multiCount.toLocaleString()}回`);
  } else {
    lines.push("・マルチ: 計測できませんでした");
  }
  if (gpuCount !== null && gpuCount !== undefined) {
    lines.push(`・GPU: ${gpuCount.toLocaleString()}回`);
  } else {
    lines.push("・GPU: 計測できませんでした");
  }
  lines.push("だった！");
  lines.push("#素因数分解ベンチマーク");
  const text = lines.join("\n");
  const shareUrl = new URL("https://twitter.com/intent/tweet");
  shareUrl.searchParams.set("text", text);
  shareUrl.searchParams.set("url", window.location.href);
  window.open(shareUrl.toString(), "_blank", "noopener,noreferrer");
});

loadGpuSize();
