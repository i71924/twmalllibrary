// 每週更新的組別：每組對應哪些擷取程式、負責哪些官網（以商場 meta.source_url 的網域判斷）。
// local：官網會擋 GitHub 機房的 IP，只能在本機（台灣家用網路）跑。
export type Job = { scripts: string[]; hosts: string[]; title: string; local?: boolean };

export const JOBS: Record<string, Job> = {
  skm: { scripts: ['skm', 'skmpark'], hosts: ['www.skm.com.tw', 'www.skmpark.com'], title: '新光三越', local: true },
  breeze: { scripts: ['breeze'], hosts: ['www.breeze.com.tw'], title: '微風' },
  sogo: { scripts: ['sogo'], hosts: ['info.sogo.com.tw', 'www.gardencity.com.tw'], title: '遠東SOGO＋Garden City', local: true },
  hanshin: { scripts: ['hanshin'], hosts: ['www.hanshin.com.tw'], title: '漢神' },
  tsrd: { scripts: ['tsrd'], hosts: ['www.tsrd.com.tw'], title: '南紡購物中心' },
  kssogo: { scripts: ['kssogo'], hosts: ['www.kssogo.com.tw'], title: '廣三SOGO' },
  themall: { scripts: ['themall'], hosts: ['www.themall.com.tw'], title: '遠企購物中心' },
  feds: { scripts: ['feds'], hosts: ['www.feds.com.tw'], title: '遠東百貨' },
  mitsui: { scripts: ['mitsui'], hosts: ['www.mitsui-shopping-park.com.tw'], title: '三井' },
  gloria: { scripts: ['gloria'], hosts: ['www.gloriaoutlets.com'], title: '華泰名品城' },
};

