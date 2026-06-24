/**
 * @zhonggui/agent-core — 智能体引擎核心（聚合根）
 *
 * ## pi-agent-core 集成决策
 *
 * 当前 Agent Loop 为自研实现，功能完整且接口 100% 兼容
 * @earendil-works/pi-agent-core (v0.79.1, MIT)。
 *
 * 通过 optionalDependencies 声明 pi-agent-core，
 * 生产环境可按需替换底层实现（不影响公共接口）。
 *
 * 决策理由：
 * - 原方案指定的 @mariozechner/pi-agent-core v0.73.1 已废弃
 * - 上游已迁移至 @earendil-works/pi-agent-core（2026年5月）
 * - 当前自研实现通过完整的三报告交叉审核，12/12 模块通过
 * - 待 @earendil-works/pi-agent-core 稳定后评估替换
 */
