import DefaultTheme from "vitepress/theme";
import AgentLoopTrace from "./components/AgentLoopTrace.vue";
import ContextComposer from "./components/ContextComposer.vue";
import CourseMap from "./components/CourseMap.vue";
import EvalTraceBench from "./components/EvalTraceBench.vue";
import RuntimeLedger from "./components/RuntimeLedger.vue";
import ToolPipeline from "./components/ToolPipeline.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("AgentLoopTrace", AgentLoopTrace);
    app.component("ContextComposer", ContextComposer);
    app.component("CourseMap", CourseMap);
    app.component("EvalTraceBench", EvalTraceBench);
    app.component("RuntimeLedger", RuntimeLedger);
    app.component("ToolPipeline", ToolPipeline);
  },
};
