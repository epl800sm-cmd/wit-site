// 위트 레일 훈련소 채점 서버 (Vercel 함수)
// 환경변수: GEMINI_API_KEY (필수), GEMINI_MODEL (선택, 기본 gemini-flash-latest)

const RULES = `너는 "위트 레일 훈련소"의 교관이다. 위트 = 상대가 깐 전제를 부정하지 않고 받아들인 채, "이 말이 100% 사실이라면?"으로 밀어붙여 뜻밖의 방향으로 트는 것.
틀기 방법: 빈칸 채우기(육하원칙 중 생략된 부분 상상), 의미 바꾸기(의도 말고 문자 그대로 받기).
목적지: 대화 목적(웃기기/위로/관계 지키기/여유 보여주기)에 맞아야 한다. 위로가 필요한 자리에서 드립은 실패다.
실패 유형: 공감 반복(전제만 따라감), 무리수(전제 무시), 말장난(단어만 따옴), 분위기 파괴(목적 무시), 전제 부정(반박·변명).`;

const TYPES = {
  all: "일상/공격/양자택일 중 아무거나(가끔 위로가 필요한 진지한 함정 문제)",
  daily: "일상",
  attack: "나를 깎아내리는 공격",
  choice: "곤란한 양자택일 질문",
};

// IP별 간단한 사용 제한 (10분에 40회). 서버가 여러 대로 뜨면 느슨해지니
// 진짜 상한은 Google AI Studio의 할당량으로 막는다.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 40;
}

const clip = (v, n = 300) => String(v ?? "").slice(0, n);

function buildPrompt(b) {
  if (b.kind === "eval") {
    const c = b.card || {};
    return `${RULES}

[문제]
상황: ${clip(c.ctx)}
상대 대사: "${clip(c.line)}"
대화 목적: ${clip(c.goal, 40)}
${c.trap ? "(이 문제는 위트보다 공감이 정답인 함정 문제다.)" : ""}

[학생 답] (반응 시간 ${Number(b.time || 0).toFixed(1)}초)
"${clip(b.answer, 400)}"

이 답을 냉정하게 평가해라. 칭찬으로 시작하지 말고, 별로면 별로라고 해라. 한국어 반말로, 짧고 직설적으로.
JSON 하나만 답해라:
{"verdict":"위트|공감 반복|무리수|말장난|분위기 파괴|전제 부정|좋은 공감","premise":"이 대사에 깔린 전제 한 줄","caught":true,"scores":{"p":0,"s":0,"g":0},"why":"판정 이유 한 문장","fix":"고칠 점 딱 1개, 한 문장","better":"학생 답을 살려서 고친 버전 한 줄(함정 문제면 공감 답)"}
점수는 각 0~3. p=전제 활용, s=의외성, g=목적 적합.`;
  }
  if (b.kind === "new") {
    const want = TYPES[b.type] || TYPES.all;
    return `${RULES}

위트 연습용 상황 카드를 1개 새로 만들어라. 유형: ${want}.
한국 20대가 실제로 들을 법한 자연스러운 구어체 대사로. 친구, 가족, 연애, 알바·회사, 처음 만난 자리 등 매번 다르게.
JSON 하나만 답해라:
{"t":"daily|attack|choice|serious","ctx":"상황 한 줄","line":"상대 대사","goal":"웃기기|위로|관계 지키기|여유 보여주기 등","premise":"깔린 전제 한 줄","blank":"빈칸 채우기 힌트, 없으면 빈 문자열","mean":"의미 바꾸기 힌트, 없으면 빈 문자열","ex":[["빈칸","예시 답"],["의미","예시 답"]],"note":"목적지 관련 코멘트 한 줄","trap":false}
serious 유형이면 trap은 true, ex는 [["공감","공감 답"]] 하나.`;
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY가 설정되지 않음" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (limited(ip)) return res.status(429).json({ error: "too many requests" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  const prompt = buildPrompt(body || {});
  if (!prompt) return res.status(400).json({ error: "bad kind" });

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: body.kind === "new" ? 1.0 : 0.4,
          },
        }),
      }
    );
    if (r.status === 429) return res.status(429).json({ error: "quota" });
    if (!r.ok) {
      const t = await r.text();
      console.error("Gemini error", r.status, t.slice(0, 500));
      return res.status(502).json({ error: "upstream" });
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    const obj = JSON.parse(m ? m[0] : text);
    return res.status(200).json(obj);
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "parse" });
  }
};
