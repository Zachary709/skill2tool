1. 读取输入中的 command 和 args，确认存在明确程序，不生成未被要求的命令。
2. 调用 service_call，服务名为 run，参数仅包含用户提供的 command 和 args。
3. 读取实际执行结果，保留真实退出状态、信号以及程序的 stdout 和 stderr；服务失败时报告实际错误，不进行重试。
4. 调用 submit_result，结果只包含 exitCode、signal、stdout 和 stderr。
