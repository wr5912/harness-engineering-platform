# 本地固定 KEV 校准报告（非远端 CLI 完成）

n=7  shipped T=1.00  workload T=0.71  folds T=[0.25, 0.81, 1.10]
arm              acc    ece  brier    nll   conf  c-err  cov@5%   aurc
raw            0.429  0.221  0.722  1.488  0.359  0.000    0.00  0.508
shipped        0.429  0.221  0.722  1.488  0.359  0.000    0.00  0.508
workload       0.429  0.219  0.719  1.453  0.451  0.000    0.00  0.544
workload_oof   0.429  0.539  1.052  2.386  0.573  0.143    0.00  0.863
workload_oof - shipped  ece                     +0.317  95% CI [-0.231, +0.580]
workload_oof - shipped  brier                   +0.330  95% CI [+0.002, +0.608]
workload_oof - shipped  coverage_at_5pct_error  +0.000  95% CI [-0.833, +0.000]
workload_oof - shipped  aurc                    +0.355  95% CI [+0.000, +0.553]

远端原作业结果仍未知；本报告只在本地以固定提交源码的原函数、固定校准 rows 运行，不修改 checkpoint、不读取 test。
