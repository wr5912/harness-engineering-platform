export const name = 'migration-quote-tools'
export const inject = ['tools']
export function apply(ctx: any) {
  ctx.tools.register({ name: 'quote', description: '计算折扣后报价', parameters: { type: 'object', properties: { quantity: { type: 'number' }, unit_price: { type: 'number' }, discount_pct: { type: 'number' } }, required: ['quantity', 'unit_price', 'discount_pct'] },
    output: { schema: { type: 'object', properties: { quantity: { type: 'number' }, unit_price: { type: 'number' }, discount_pct: { type: 'number' }, total: { type: 'number' } }, required: ['quantity', 'unit_price', 'discount_pct', 'total'] }, render(_input: unknown, value: unknown) { return [{ type: 'text', text: JSON.stringify(value) }] } },
    async execute(input: { quantity: number; unit_price: number; discount_pct: number }) {
      if (input.quantity < 0 || input.unit_price < 0 || input.discount_pct < 0 || input.discount_pct > 100) throw new Error('报价参数超出范围')
      return { ...input, total: Math.round(input.quantity * input.unit_price * (1 - input.discount_pct / 100) * 100) / 100 }
    } })
}
