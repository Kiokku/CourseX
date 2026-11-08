# React 18 Keyed Diff 实验

章节主画布点击“＋ Diff 实验”，生成待验证的交互实验卡片；“运行实验”打开操作界面。修改旧/新列表、保存运行，再逐步查看或显示全部结果。输入格式为 `A:li,B:li`，同一列表 key 唯一、最多 20 个节点；空列表表示没有节点。

模型 v1 固定 React 18.2.0，源码依据是 [ReactChildFiber.new.js](https://github.com/facebook/react/blob/v18.2.0/packages/react-reconciler/src/ReactChildFiber.new.js) 中的 placeChild、updateElement 和 reconcileChildrenArray。它描述更新时显式唯一 key 的同级宿主元素：匹配 key 和标签，复用已有节点；旧索引落后于 lastPlacedIndex 时标记移动；新元素标记插入；未复用的旧元素列为删除。

输出包含操作类型、旧/新索引与 lastPlacedIndex。顺序扫描策略体现实现成本与最优移动数的取舍。模型合并了前缀扫描和映射查找；删除集中显示为分类结果，不表示真实 DOM 提交顺序。不模拟无 key 列表、组件/Fragment、嵌套树、调度、hydration 或 commit 执行，也不把“复用”误称为没有属性更新。

Card.type=experiment，experiment 保存 kind=keyed-diff、version=1、reactVersion=18.2.0 及 before/after 输入。输入通过相同校验后与卡片、布局原子保存，重开后可再次运行；逐步查看的位置是临时 UI 状态，不写成知识正文。导出包含可读输入元数据，导入恢复原输入；未知模型版本拒绝导入。移动卡片不修改实验输入。运行实验不会自动把卡片标成已验证。

自动测试覆盖不变、交换、头部插入、删除、同 key 改标签、空列表、全增/全删，以及输入和版本拒绝；另外验证保存、导出和恢复。它是可复用的一个机制实验，不是完整 React 调和器或插件平台。
