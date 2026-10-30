import { Annotation, END, START, StateGraph } from '@langchain/langgraph'

const State = Annotation.Root({ quantity: Annotation<number>, unit_price: Annotation<number>, subtotal: Annotation<number>, tax: Annotation<number>, shipping: Annotation<number>, total: Annotation<number>, route: Annotation<string> })
export function quoteGraph() {
  return new StateGraph(State)
    .addNode('bulk', (s) => ({ subtotal: s.quantity * s.unit_price * 0.9, route: 'bulk' }))
    .addNode('regular', (s) => ({ subtotal: s.quantity * s.unit_price, route: 'regular' }))
    .addNode('calc_tax', (s) => ({ tax: Math.round(s.subtotal * 0.1 * 100) / 100 }))
    .addNode('calc_shipping', (s) => ({ shipping: s.subtotal >= 100 ? 0 : 5 }))
    .addNode('join', (s) => ({ total: Math.round((s.subtotal + s.tax + s.shipping) * 100) / 100 }))
    .addConditionalEdges(START, s => s.quantity >= 10 ? 'bulk' : 'regular', ['bulk', 'regular'])
    .addEdge('bulk', 'calc_tax').addEdge('bulk', 'calc_shipping').addEdge('regular', 'calc_tax').addEdge('regular', 'calc_shipping')
    .addEdge(['calc_tax', 'calc_shipping'], 'join').addEdge('join', END).compile()
}
export const sourceModel = { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-flash', reasoningEffort: 'off' }
