from agentscope.agent import Agent
from agentscope.tool import Toolkit
from version_tool import select_newer_version


def build_agent(model):
    return Agent(name="version-advisor", system_prompt="必须调用 select_newer_version 比较用户提供的两个版本。缺少版本时先补问；输入无效时说明工具错误，不猜测。", model=model, toolkit=Toolkit(tools=[select_newer_version]))
