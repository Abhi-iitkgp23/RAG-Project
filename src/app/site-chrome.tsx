import { IconInfo } from "./icons";

export function BrandLockup() {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        D
      </div>
      <div className="brand-copy">
        <h1>Dietary Guidance</h1>
        <p>Evidence-based public guidance</p>
      </div>
    </div>
  );
}

const HOW_STEPS = [
  {
    index: "01",
    title: "Ask a question",
    body: "Ask about everyday dietary guidance or food safety.",
  },
  {
    index: "02",
    title: "Find relevant guidance",
    body: "The assistant searches approved public documents for passages relevant to your question.",
  },
  {
    index: "03",
    title: "Get a cited answer",
    body: "The assistant summarizes relevant information and connects factual claims to their supporting sources.",
  },
  {
    index: "04",
    title: "Check the evidence",
    body: "Open citations to check the original guidance. If the available evidence does not support an answer, the assistant should say so rather than guess.",
  },
] as const;

export function HowItWorks({ onViewSources }: { onViewSources: () => void }) {
  return (
    <div className="works-copy">
      <p className="works-lead">Clear answers, grounded in official guidance.</p>
      <ol className="works-steps">
        {HOW_STEPS.map((step) => (
          <li key={step.index}>
            <span className="works-index">{step.index}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="works-limit">
        <p className="works-limit-title">
          <IconInfo size={16} />
          What this assistant can answer
        </p>
        <p>
          This assistant provides general dietary and food-safety guidance, not
          personalized calorie targets, weight recommendations, or medical advice.
        </p>
      </div>
      <button type="button" className="works-sources" onClick={onViewSources}>
        View all sources
        <span aria-hidden="true"> ↗</span>
      </button>
    </div>
  );
}

export function AboutAssistant() {
  return (
    <section className="about" aria-labelledby="about-title">
      <IconInfo size={16} />
      <div>
        <h2 id="about-title">Official Guidance Only</h2>
        <p>
          Provides general dietary and food-safety info from official sources. Does
          not provide personalized calorie targets, weight recommendations, or medical
          advice.
        </p>
      </div>
    </section>
  );
}
