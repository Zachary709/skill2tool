1. 读取输入 command，确认用户已经提供完整且明确的命令；缺少必要信息时报告 needs_input。
2. 只调用一次 bash，将输入 command 原样作为 command 参数，不添加其他操作，不通过其他工具执行命令。
3. 等待命令实际退出，读取真实退出码与输出，失败时报告实际错误。
4. 调用 submit_result，只返回实际 exitCode 和 stdout，保留输出中的换行和重复行。
