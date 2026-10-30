# 订单报价助手

收集 quantity 和 unit_price，调用 quoteGraph，解释命中的 regular/bulk 分支和小计、税费、运费、总额。图中税费与运费并行计算，汇合后求总额。缺少参数时补问，负数输入时拒绝计算。该样例为单次无状态流程，没有 checkpoint 或中断恢复要求。
