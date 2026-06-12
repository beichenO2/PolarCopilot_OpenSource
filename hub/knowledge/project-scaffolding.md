# 项目质量门禁清单（G1-G7）

YOLO 执行阶段每个子任务完成后，Agent 必须对照此清单逐项检查。全部通过后才可 commit。

---

## G1. 文件大小控制

- [ ] 单个源文件不超过 **300 行**
- [ ] 超过 300 行的文件必须拆分为功能模块
- [ ] 配置文件（vite.config.ts、tsconfig.json 等）不受此限制

**验证命令**：
```bash
find src/ -name '*.ts' -o -name '*.tsx' | xargs wc -l | sort -rn | head -10
```

## G2. 端口管理

- [ ] 生产端口通过 `claimPort()` 或环境变量获取，不硬编码
- [ ] 开发端口（vite dev server 等）可以硬编码，但必须在方案文档中声明
- [ ] 无端口冲突（不与已有服务共用端口）

**验证命令**：
```bash
grep -rn ":[0-9]\{4\}" src/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '\/\/'
```

## G3. 测试入口

- [ ] 项目有可执行的 CLI 测试入口（`npm test` / `pytest` / `cargo test`）
- [ ] 每个用户工作流至少有一个对应的测试用例
- [ ] 测试可无交互运行（CI 兼容）

**验证命令**：
```bash
npm test 2>&1 | tail -5
```

## G4. TypeScript 编译

- [ ] `npx tsc --noEmit` 返回 0 error
- [ ] 无 `// @ts-ignore` 或 `any` 的滥用

**验证命令**：
```bash
npx tsc --noEmit 2>&1 | tail -5
```

## G5. 依赖管理

- [ ] 新增依赖已添加到 package.json / requirements.txt
- [ ] 无未声明的依赖（import 的包都在依赖列表中）
- [ ] 不引入已废弃/不维护的依赖（参照 P14 技术选型时效性）

## G6. 安全基线

- [ ] 无硬编码密钥/令牌/密码
- [ ] 无 `.env` 文件被 commit（应在 .gitignore 中）
- [ ] API 端点有基本的输入验证

**验证命令**：
```bash
grep -rn "password\|secret\|token\|api_key" src/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '\/\/'
```

## G7. 向后兼容

- [ ] 现有 API 端点不破坏已有调用方
- [ ] 现有 UI 页面功能不受影响
- [ ] 数据库 schema 变更有迁移方案
