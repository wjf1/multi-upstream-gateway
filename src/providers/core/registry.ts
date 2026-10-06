// =============================================================================
// 统一模型注册表（执行依据：master-plan v1.2 §3.3 命名空间规则 v1.1）
// -----------------------------------------------------------------------------
// 三个 Provider 的模型目录在这里汇成一张表，供路由层做第 4 步「隐式映射」：
// 客户端用裸模型名（如 `glm-5.2`）请求时，若它在表中恰好只属于一个 provider，
// 直接路由过去；命中多个 provider 则抛 MODEL_AMBIGUOUS，提示改用命名空间前缀
// （如 `workbuddy/glm-5.2`）。
//
// 设计约束：
//   - 纯内存结构、无 IO：模型列表由调用方喂入（各 Provider 的 listModels()，
//     CommandCode 侧由 T213 用底座 models.ts 的加载结果喂入）——本文件刻意不
//     import 底座 models.ts 的加载逻辑，保持可独立单测的纯函数语义；
//   - setProviderModels 为「覆盖式」写入：同一 provider 重复设置即替换旧列表
//     （目录刷新 /v1/models/refresh 的热更新语义）；
//   - 模型 ID 匹配大小写敏感（上游目录的 ID 是精确标识，如 `glm-5.2` ≠ `GLM-5.2`）。
// =============================================================================

import type { ProviderName } from './interface.js';

/** 注册表条目的最小形状（复用 IProvider.listModels() 的 OpenAIModel 亦兼容）。 */
export interface RegistryModel {
  id: string;
}

/** 固定遍历序：列表输出与 resolve 结果都按它排序，保证可预测。 */
const PROVIDER_ORDER: readonly ProviderName[] = ['commandcode', 'freebuff', 'workbuddy'];

export class ProviderRegistry {
  private readonly modelsByProvider = new Map<ProviderName, string[]>();

  /** 覆盖式设置一个 provider 的模型列表（同 provider 内重复 ID 去重）。 */
  setProviderModels(provider: ProviderName, models: readonly RegistryModel[]): void {
    this.modelsByProvider.set(provider, [...new Set(models.map((m) => m.id))]);
  }

  /**
   * 裸模型名 → 命中的 provider 数组（按 PROVIDER_ORDER 排序）。
   * 长度 0：注册表未收录（路由层落空，继续后续步骤）；
   * 长度 1：唯一命中，允许裸名直用；
   * 长度 ≥2：歧义，路由层抛 MODEL_AMBIGUOUS(400)。
   */
  resolve(bareModel: string): ProviderName[] {
    return PROVIDER_ORDER.filter((p) => this.modelsByProvider.get(p)?.includes(bareModel));
  }

  /** 带命名空间前缀的合并模型列表（`GET /v1/models` 聚合口径，§3.3）。 */
  listNamespaced(): string[] {
    const out: string[] = [];
    for (const p of PROVIDER_ORDER) {
      for (const id of this.modelsByProvider.get(p) ?? []) {
        out.push(`${p}/${id}`);
      }
    }
    return out;
  }
}
