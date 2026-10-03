# Orçamento da obra: evidência e alocação de equipamento

`ConstructionBudgetPanel` lê medidas aceitas no projeto, relaciona-as às composições do catálogo e envia IDs de medida à API. A quantidade física aceita não é editável nem substituída por valores do navegador. O cálculo salva um snapshot com fontes, pendências e cobertura parcial; preços ausentes continuam `null`.

Os equipamentos referenciados por cada serviço possuem uma entrada manual separada de **alocação de uso**, em EA. Ela não é uma medida física extraída por IA nem uma escolha automática de máquina. Quantidade, aplicabilidade, compartilhamento, referência do uso/locação e revisão precisam ser informados pelo responsável. O campo começa vazio, sem presumir uma unidade. Faixa suportada: 0 a 1.000.000, até seis casas decimais; referência de fonte de até 240 caracteres. Quantidade conhecida sem fonte ou sem revisão permanece pendente. Equipamentos não referenciados pela composição não são incluídos pelo draft do cliente.

Ao repartir um mesmo uso/contrato de locação entre serviços, o responsável deve documentar a alocação e evitar repetir a quantidade integral em cada serviço. A API valida o projeto, a composição e o equipamento referenciado; o checkbox do navegador não aprova acesso, capacidade estrutural ou segurança de operação.

O custo depende, adicionalmente, do catálogo documentado: período de aluguel, operador, transporte/retirada, combustível, mobilização, montagem/desmontagem, horas extras, taxas e condições de acesso/site quando aplicáveis. Informar uma alocação não preenche preços ou produtividade. A interface oferece um template do catálogo com esses inputs pendentes, sem defaults monetários.

Contrato enviado por seleção:

```ts
equipmentAllocations?: Record<equipmentId, {
  quantity: number | null;
  unit: 'EA';
  reviewed: boolean;
  sourceRef: string | null;
}>;
```

Cotações são documentos importados com SKU/modelo/especificação, loja, ZIP, fuso e timestamps originais. Nenhum crawler ou chamada a fornecedor/IA inicia pelo painel. Preço SaaS e cobranças permanecem separados do orçamento da obra.

Histórico é carregado por snapshot: metadados com `detailLoaded:false` exigem abrir a evidência salva antes de visualizar o cálculo completo. Flags de subset para medidas, snapshots e cotações são exibidas; refresh não implica cobertura completa do projeto.

Validação focada: `node --experimental-strip-types --test apps/web/test/construction-budget-ui.test.ts`; **27 testes offline aprovados**, incluindo alocação desconhecida, compartilhada, sem fonte/revisão, fora da faixa e tentativa de substituir a medida aceita. TypeScript estrito do cliente/painel aprovado. Nenhuma chamada paga executada nesta frente.
