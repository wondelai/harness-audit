import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { t } from './i18n.js';
import type { InterviewAnswer, InterviewResult, InterviewRole, Lang, LocalizedText } from './types.js';

export interface InterviewQuestion {
  id: string;
  question: LocalizedText;
  gapHint: LocalizedText;
  choices: Array<{
    score: 0 | 1 | 2;
    label: LocalizedText;
  }>;
}

export const INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  {
    id: 'org.daily-adoption',
    question: {
      en: 'How consistently does the team use coding agents (Claude Code, Codex, Cursor) in daily work?',
      pl: 'Jak konsekwentnie zespół korzysta z agentów kodujących (Claude Code, Codex, Cursor) w codziennej pracy?',
    },
    gapHint: {
      en: 'Patchy agent adoption creates inconsistent conventions and makes harness investments hard to compound.',
      pl: 'Nierówna adopcja agentów tworzy niespójne konwencje i utrudnia zwrot z inwestycji w uprząż.',
    },
    choices: [
      { score: 0, label: { en: 'Ad-hoc — a few people experiment, most still code manually', pl: 'Ad-hoc — kilka osób eksperymentuje, większość koduje ręcznie' } },
      { score: 1, label: { en: 'Most engineers use agents daily, each with personal prompts/setup', pl: 'Większość używa codziennie, ale z własnymi promptami/konfiguracją' } },
      { score: 2, label: { en: 'Standardized team workflow with shared instructions, rules, and onboarding', pl: 'Ustandaryzowany proces zespołu ze wspólnymi instrukcjami i onboardingiem' } },
    ],
  },
  {
    id: 'org.review-bottleneck',
    question: {
      en: 'Where does PR review stand as agent output grows?',
      pl: 'Jak wygląda kolejka code review wraz ze wzrostem liczby zmian od agentów?',
    },
    gapHint: {
      en: 'Review queue backlog is the classic Level 3 ceiling — move reviewers from line-by-line reading to evidence bundles + risk classes.',
      pl: 'Zator w code review to klasyczny sufit Poziomu 3 — przejdź z czytania linia po linii na pakiety dowodów i klasy ryzyka.',
    },
    choices: [
      { score: 0, label: { en: 'Large agent PRs pile up or get rubber-stamped without real verification', pl: 'Duże PR-y agentów piętrzą się lub są klepane bez realnej weryfikacji' } },
      { score: 1, label: { en: 'Humans read every diff line by line — review is our main bottleneck', pl: 'Ludzie czytają każdy diff linia po linii — review to główne wąskie gardło' } },
      { score: 2, label: { en: 'Low/medium PRs review from evidence bundles; line-by-line review is reserved for high/critical risk paths', pl: 'Niskie/średnie ryzyko oceniane jest z pakietu dowodów; pełne czytanie kodu dotyczy krytycznych ścieżek' } },
    ],
  },
  {
    id: 'org.spec-first',
    question: {
      en: 'How are tasks specified before an agent starts coding?',
      pl: 'Jak zadania są specyfikowane, zanim agent zacznie pisać kod?',
    },
    gapHint: {
      en: 'Prompting straight into code without acceptance criteria causes rework; adopt plan mode and committed specs for multi-file tasks.',
      pl: 'Promptowanie wprost w kod bez kryteriów akceptacji generuje poprawki — wprowadź tryb planowania i specyfikacje dla większych zmian.',
    },
    choices: [
      { score: 0, label: { en: 'One-line prompts or vague tickets — scope emerges while iterating', pl: 'Jednolinijkowe prompty lub ogólne tickety — zakres wychodzi w trakcie' } },
      { score: 1, label: { en: 'Plan mode / written tasks used sometimes, depending on the developer', pl: 'Tryb planowania / pisane zadania używane czasem, zależnie od osoby' } },
      { score: 2, label: { en: 'Multi-file work starts with explicit acceptance criteria and a machine-checkable stop condition', pl: 'Większe zmiany startują od jasnych kryteriów akceptacji i maszynowego warunku stopu' } },
    ],
  },
  {
    id: 'org.spend-and-outcomes',
    question: {
      en: 'How do you track AI spend alongside engineering outcomes (throughput AND stability)?',
      pl: 'Jak mierzycie wydatki na AI w zestawieniu z wynikami (przepustowość ORAZ stabilność)?',
    },
    gapHint: {
      en: 'Tracking seats or token spend without change failure / revert rate hides quality regressions (the DORA/Faros whiplash).',
      pl: 'Śledzenie samych licencji lub tokenów bez wskaźnika awarii/revertów ukrywa spadek stabilności.',
    },
    choices: [
      { score: 0, label: { en: 'We do not track AI spend or delivery stability separately', pl: 'Nie śledzimy wydatków AI ani stabilności dostaw osobno' } },
      { score: 1, label: { en: 'We track seat/token spend and velocity, but not revert/incident rate per workflow', pl: 'Śledzimy koszt licencji/tokenów i prędkość, ale nie revert/incydenty' } },
      { score: 2, label: { en: 'We pair throughput/cost with change failure rate, revert rate, and review wait time', pl: 'Zestawiamy przepustowość i koszt z change failure rate, revertami i czasem oczekiwania na review' } },
    ],
  },
  {
    id: 'org.incident-attribution',
    question: {
      en: 'When an agent-assisted change causes a regression or incident, what happens next?',
      pl: 'Gdy zmiana wspomagana przez agenta powoduje regresję lub incydent, co dzieje się dalej?',
    },
    gapHint: {
      en: 'Without feeding regressions back into tests, rules, and harness guards, agents repeat the same class of mistake indefinitely.',
      pl: 'Bez przekładania incydentów na nowe testy, reguły i blokady w uprzęży agenci powtarzają tę samą klasę błędów.',
    },
    choices: [
      { score: 0, label: { en: 'We patch the bug and move on — no harness or oracle update', pl: 'Łatamy błąd i idziemy dalej — bez aktualizacji testów ani uprzęży' } },
      { score: 1, label: { en: 'We usually add a regression test, occasionally update AGENTS.md', pl: 'Zwykle dodajemy test regresyjny, sporadycznie aktualizujemy AGENTS.md' } },
      { score: 2, label: { en: 'Every incident adds a regression test / lint rule / harness guardrail and demotes unsafe loops', pl: 'Każdy incydent dodaje test regresyjny / regułę lintera / blokadę i cofa niebezpieczną pętlę pod nadzór' } },
    ],
  },
  {
    id: 'org.senior-buyin',
    question: {
      en: 'How engaged are senior/staff engineers in shaping your agent harness and standards?',
      pl: 'Jak zaangażowani są seniorzy/staff engineerowie w budowanie uprzęży i standardów dla agentów?',
    },
    gapHint: {
      en: 'When seniors stay skeptical on the sidelines, juniors ship unchecked agent code while seniors burn out reviewing it.',
      pl: 'Gdy seniorzy stoją z boku, juniorzy generują niesprawdzony kod, a seniorzy wypalają się na review.',
    },
    choices: [
      { score: 0, label: { en: 'Seniors mostly reject AI tools or spend their time cleaning up agent PRs', pl: 'Seniorzy odrzucają narzędzia AI lub spędzają czas na sprzątaniu PR-ów po agentach' } },
      { score: 1, label: { en: 'A few seniors champion it; standards are still informal', pl: 'Kilku seniorów wspiera adopcję, ale standardy są wciąż nieformalne' } },
      { score: 2, label: { en: 'Seniors own architecture invariants, test oracles, and harness rules that multiply the whole team', pl: 'Seniorzy odpowiadają za niezmienniki architektury, wyrocznie testowe i reguły uprzęży dla całego zespołu' } },
    ],
  },
  {
    id: 'org.risk-boundaries',
    question: {
      en: 'Are high-risk change classes (auth, payments, schema migrations, CI/tests) explicitly gated for human code review?',
      pl: 'Czy klasy zmian wysokiego ryzyka (auth, płatności, migracje schematu, CI/testy) mają jawny wymóg ludzkiego code review?',
    },
    gapHint: {
      en: 'Autonomy applies per loop, while risk classes cap every change — critical paths must always require human code reading.',
      pl: 'Autonomia dotyczy pętli, ale klasa ryzyka ogranicza każdą zmianę — ścieżki krytyczne zawsze muszą wymagać czytania kodu przez człowieka.',
    },
    choices: [
      { score: 0, label: { en: 'No formal distinction between low-risk and critical-risk changes', pl: 'Brak formalnego rozróżnienia między zmianami niskiego i krytycznego ryzyka' } },
      { score: 1, label: { en: 'Informal team norm, not enforced by CODEOWNERS or CI rules', pl: 'Nieformalna norma w zespole, bez wymuszania przez CODEOWNERS lub CI' } },
      { score: 2, label: { en: 'Explicit risk classes enforced via CODEOWNERS / branch protection and PR evidence checks', pl: 'Jawne klasy ryzyka wymuszane przez CODEOWNERS / ochronę gałęzi i kontrolę dowodów na PR' } },
    ],
  },
];

export function scoreInterview(
  role: InterviewRole,
  selections: Record<string, 0 | 1 | 2>,
): InterviewResult {
  const answers: InterviewAnswer[] = [];
  const gaps: LocalizedText[] = [];
  let sum = 0;

  for (const q of INTERVIEW_QUESTIONS) {
    const score = selections[q.id] ?? 0;
    const choice = q.choices.find((c) => c.score === score) ?? q.choices[0]!;
    answers.push({
      id: q.id,
      question: q.question,
      choiceLabel: choice.label,
      score: choice.score,
    });
    sum += choice.score;
    if (choice.score < 2) {
      gaps.push(q.gapHint);
    }
  }

  const maxScore = INTERVIEW_QUESTIONS.length * 2;
  const pct = Math.round((sum / maxScore) * 100);

  return {
    role,
    score: pct,
    answers,
    gaps,
  };
}

export async function runInteractiveInterview(
  role: InterviewRole,
  lang: Lang,
): Promise<InterviewResult> {
  const rl = createInterface({ input: stdin, output: stdout });
  const selections: Record<string, 0 | 1 | 2> = {};

  try {
    stdout.write(
      lang === 'pl'
        ? `\n=== Wywiad organizacyjny i procesowy (rola: ${role}, 7 pytań) ===\nOdpowiedz cyfrą 1, 2 lub 3.\n\n`
        : `\n=== Org & Workflow Interview (role: ${role}, 7 questions) ===\nEnter 1, 2, or 3 for each question.\n\n`,
    );

    for (let i = 0; i < INTERVIEW_QUESTIONS.length; i++) {
      const q = INTERVIEW_QUESTIONS[i]!;
      stdout.write(`${i + 1}/${INTERVIEW_QUESTIONS.length}. ${t(q.question, lang)}\n`);
      q.choices.forEach((choice, idx) => {
        stdout.write(`   [${idx + 1}] ${t(choice.label, lang)}\n`);
      });

      let picked: 0 | 1 | 2 | null = null;
      while (picked === null) {
        const raw = (await rl.question(lang === 'pl' ? 'Twój wybór (1-3): ' : 'Choice (1-3): ')).trim();
        if (raw === '1') picked = 0;
        else if (raw === '2') picked = 1;
        else if (raw === '3') picked = 2;
        else {
          stdout.write(lang === 'pl' ? 'Wpisz 1, 2 lub 3.\n' : 'Please enter 1, 2, or 3.\n');
        }
      }
      selections[q.id] = picked;
      stdout.write('\n');
    }
  } finally {
    rl.close();
  }

  return scoreInterview(role, selections);
}
