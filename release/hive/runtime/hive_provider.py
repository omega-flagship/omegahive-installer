"""Adapt Hive's existing text-command protocol to upstream tool responses.

Upstream owns request/response objects and dispatch. The single transport tool
enters Hive's existing parser and per-command authorization, never raw eval.
"""
import providers


def tools():
    parameter = providers.LLMToolParameter().with_name('text')
    return [providers.LLMTool().with_name('hive-run-response')
            .with_description('Parse and authorize a Hive skill response')
            .with_parameters([parameter])]


def response(text):
    tool = tools()[0]
    call = providers.LLMToolCall().with_name(tool.name).with_id('hive-response')
    call.add_argument('text', str(text))
    call.set_tool(tool)
    return providers.LLMResponse().add_tool_call(call)
