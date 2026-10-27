import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context } from '@deepseek-ai/cordis'

export function bindNewConversation(ctx: Pick<Context, 'uiWorkspace' | 'workspaces'>) {
  const navigation = ctx.uiWorkspace
  const startSession = navigation.startSession
  navigation.startSession = (_workspaceId, options) => {
    const workspace = ctx.workspaces.list.getSnapshot().items[0]
    startSession.call(navigation, workspace?.workspaceId, options)
  }
  return () => { navigation.startSession = startSession }
}

export function prepareConversation(layout: ILayout, sidebarCollapsed?: boolean) {
  // 首次进入或首页新任务按原生实际状态收起；普通导航保留用户选择。
  if (sidebarCollapsed === false) layout.toggleSidebar()
  if (layout.panelInfo.getSnapshot().activePanelId !== null) layout.selectPanel(null)
}
