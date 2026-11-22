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
 * 画面に見えない canvas（N×N）に素因数分解の結果を「色（HEX）」として描き、
 * その HEX 文字を数値に戻して検算する。1 ピクセル = 1 回の素因数分解。
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
  let gl = null, canvas = null, prog = null, U = {}, tex = null, fbo = null, size = 0, tried = false;

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

  function init(n) {
    if (!tried) {
      tried = true;
      try {
        canvas = document.createElement("canvas");
        canvas.className = "gpu-canvas";
        canvas.style.cssText = "position:fixed;left:0;top:0;border:0;pointer-events:none;opacity:0";
        canvas.setAttribute("aria-hidden", "true");
        document.body.appendChild(canvas);
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
      } catch (e) {
        console.error("[gpu]", e);
        gl = null;
        return false;
      }
    }
    if (!gl) return false;
    const n2 = Math.min(n, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    if (size !== n2) {
      size = n2;
      canvas.width = size;
      canvas.height = size;
      canvas.style.width = size + "px";
      canvas.style.height = size + "px";
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
      gl.viewport(0, 0, size, size);
    }
    return true;
  }

  // 1 回描画する = size × size 回ぶんの素因数分解。結果は各ピクセルの色（RGBA = 8桁のHEX）で返る
  function pass(hi, lo) {
    gl.uniform1ui(U.hi, hi);
    gl.uniform1ui(U.lo, lo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  return { init, pass, get size() { return size; }, get lost() { return !gl || gl.isContextLost(); } };
})();

// 色のバイト列(RGBA)を HEX 文字にして、その文字を数値に戻す
function pixelToHex(px, i) {
  return Array.from(px.subarray(i * 4, i * 4 + 4), (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function runGpuBenchmark() {
  if (!gpuBench.init(getGpuSize())) {
    throw new Error("このブラウザでは WebGL2 が使えません");
  }

  const N = BigInt(FACTORIZATION_TARGET);
  if (N >= (1n << 62n)) throw new Error("GPU 計測は 2^62 未満の数に対応しています");
  const hi = Number(N >> 32n);
  const lo = Number(N & 0xFFFFFFFFn);
  const expected = Math.max(...primeFactorization(FACTORIZATION_TARGET));   // CPU で求めた最大の素因数（検算用）
  const expectedHex = expected.toString(16).padStart(8, "0").toUpperCase();
  const pixels = gpuBench.size * gpuBench.size;

  // 準備運動: シェーダのコンパイルなどが計測に入らないよう、先に 1 回だけ空打ちする
  gpuBench.pass(hi, lo);

  const deadline = performance.now() + BENCHMARK_DURATION_MS;
  let count = 0;
  let lastHex = "";

  while (performance.now() < deadline) {
    if (gpuBench.lost) throw new Error("GPU のコンテキストが失われました");
    const px = gpuBench.pass(hi, lo);
    const finishedInTime = performance.now() <= deadline;   // 時間内に終わった回だけ数える

    let ok = 0;
    for (let i = 0; i < pixels; i++) {
      const hex = pixelToHex(px, i);
      lastHex = hex;
      if (hex === expectedHex) ok++;       // HEX 文字が CPU の答えと一致したものだけ成功
    }
    if (ok !== pixels) {
      throw new Error(`GPU の結果が一致しません（期待 #${expectedHex} / 実際 #${lastHex}）`);
    }
    if (finishedInTime) count += ok;

    updateLog(`GPU計測中: ${count.toLocaleString()} 回（最後のHEX #${lastHex}）`);
    gpuHexLabel.textContent = `GPUの結果HEX: #${lastHex}（最大の素因数 ${parseInt(lastHex, 16).toLocaleString()}）`;
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
