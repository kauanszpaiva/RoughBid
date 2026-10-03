# Evidência de navegador local — RoughBid, 02/10/2026

Foi executado Chrome headless com perfil novo e servidor Vite exclusivo em
`127.0.0.1:4187`. O harness importa os componentes reais `AuthGate`, `PlansPage`,
`AIPlanModal` e `PhotoTakeoffPanel`; API, identidade, armazenamento e processamento
são fixtures. Uma faixa visível identifica essa condição em todas as screenshots.

**Resultado: 13/13 verificações passaram, zero exceções não capturadas, zero
tentativas de destinos externos e zero chamadas pagas.** O CDP intercepta todos os
requests antes da navegação e rejeita destinos externos. O fetch de fixture também
rejeita destinos externos e responde 501 para qualquer endpoint de API não
simulado. A configuração Vite usa `envDir` exclusivo sem arquivos env e constantes
públicas fictícias; não lê credenciais locais. O perfil do Chrome é separado da
janela/perfil que o usuário utiliza.

## Percursos verificados

- Login: link expirado com recuperação legível, sem exibir a descrição privada
  recebida no callback; email inválido não envia request; email válido é
  normalizado e gera confirmação de request aceito pela API simulada.
- Planta: PDF sintético de duas folhas passa por reserva, upload PUT e conclusão;
  o visualizador PDF real renderiza o arquivo. Full V2 é escolhido explicitamente,
  o job simulado registra progresso e permite cancelamento uma única vez e retomada.
  Recarregar a página recupera a revisão/job salvo na fixture. Expandir uma etapa
  busca apenas seu checkpoint, exibindo folha, fonte e pendências de geometria/preço.
- Foto: PNG sintético passa por upload privado e job simulado. Sem referência,
  quantidade física permanece indeterminada e preço ausente. O preview verifica
  SHA-256 e mostra a região de evidência. Uma revisão humana simulada, com leitura
  de instrumento informada, vincula a referência à região `wall-a` e exibe `120 SF`;
  o preço e a revisão independente continuam pendentes. Não é uma medição real.
- Permissões/viewport: controles de upload, execução e revisão permanecem
  bloqueados para viewer; viewport de 390 × 844 px não tem overflow horizontal.

## Artefatos

No executor desta rodada, `../deliverables/offline-browser/` contém:

- `offline-browser-report.json`: asserts, destinos solicitados, requests mock e
  timestamps da execução aprovada.
- `01-auth-local-accepted.png`, `02-plan-durable-progress.png`,
  `03-plan-saved-evidence.png`, `04-photo-unscaled-evidence.png`,
  `05-photo-human-reference.png`, `06-mobile-photo-flow.png`.
- `offline-floor-plan.pdf` e `offline-wall-photo.png`, ambos fontes sintéticas.

O log é `../offline-browser-qa.log`. Os artefatos de navegador são externos ao Git;
o código e a documentação da fixture são revisáveis no repositório.

## Reproduzir

Com dependências instaladas e Chrome disponível no Windows:

```powershell
powershell -NoProfile -File scripts/offline-browser-fixture.ps1
```

O launcher usa processos ocultos, portas exclusivas 4187/9317 e perfil novo,
recusando iniciar caso as portas estejam ocupadas. Ao terminar, encerra somente os
processos que criou. Também é possível iniciar o Vite com
`node node_modules/vite/bin/vite.js --config scripts/offline-browser-fixture.vite.ts`,
abrir Chrome headless isolado com depuração localhost 9317 e executar
`node scripts/offline-browser-fixture.qa.mjs`. A execução aprovada usou esses passos
separadamente; o launcher equivalente teve sua sintaxe PowerShell verificada.

## Limites da prova

Esta execução verifica comportamento integrado dos componentes reais com mocks.
Ela não verifica entrega de email, login Supabase de produção, App completo com
bootstrap remoto, RLS, upload de cliente, banco externo, Redis/BullMQ real, worker
externo ou inferência de fornecedores. Persistência da fixture é localStorage,
distinta da persistência SQL/worker implementada e testada separadamente. Não houve
inference, upload Kamai/APS, produto/checkout Stripe real ou avaliação de precisão
em planta/foto real. Esses testes permanecem fora da autorização desta rodada.

## Verificações adicionais de geometria e orçamento

Sem repetir o percurso inicial, foram executadas mais **13/13 verificações de
geometria e preço SaaS** e **8/8 de orçamento da obra**. Os três relatórios são
separados: 34 asserts aprovados no conjunto, zero exceções não capturadas e zero
requisições externas observadas em cada execução. Não houve chamadas pagas.

O `PlanMeasurementPanel` real verifica o SHA-256 e as dimensões da folha antes
de renderizar um PDF sintético. Escolher um candidato nativo apenas localiza sua
região: não produz quantidade, e salvar sem traçar o elemento é recusado. O driver
traça uma superfície real do arquivo de fixture e duas referências dimensionais
independentes de 4 ft. A função **real, local e determinística `reviewMeasurement`**
valida o payload e calcula 64 SF. O navegador não envia quantidade pronta. A
revisão recupera após reload, mantém cobertura limitada aos elementos selecionados
e preço pendente; o papel viewer pode consultar, mas não gravar a revisão.

O `SaasPricingPreview` real aparece apenas com a flag de owner. Os valores mensais
ficam pendentes sem parâmetros documentados. Um cenário hipotético de custo,
identificado como forecast, permite revisar o cálculo local e seu registro
auditável; não ativa cobrança nem chama API. A política por documento é a existente
e versionada no repositório; o teste não estabelece preço comercial novo.

O `ConstructionBudgetPanel` real, integrado ao `PlansPage`, recebe os 64 SF
aceitos e seleciona uma composição compatível. SAVE envia o ID da medida, a
composição e entradas ainda pendentes, sem substituir a quantidade aceita.
O mock retorna **snapshot direto**, com quantidade 64 SF, preços e total `null`;
a UI exibe Pending, nunca US$0 como preço ausente. Reload recupera um único
snapshot e a evidência é carregada pelo seu `snapshot_id`, sem repetir o POST.
O viewer consulta a revisão, mas não salva. ZIP, cotação de produto, embalagem,
perda e produtividade permanecem explicitamente pendentes.

A persistência do orçamento e sua resposta de cálculo neste browser QA são
**mocks de API/localStorage**. Apenas a validação e o cálculo geométrico usam a
função real no Node local. Isso não prova SQL, RLS, cadastro de fornecedor ou
preço de mercado; tais partes têm validações locais separadas no pacote de backend.

Artefatos adicionais em `../deliverables/offline-browser/`:

- `offline-browser-geometry-report.json`: 13 asserts adicionais.
- `offline-browser-budget-report.json`: 8 asserts adicionais.
- `offline-browser-capture-report.json`: captura de apresentação, sem novos asserts.
- `07-plan-geometry-calibration.png`, `08-saas-monthly-pending.png`,
  `09-saas-local-preview-record.png`, `10-budget-saved-pending-quotes.png`,
  `11-budget-recovered-evidence.png`, `12-plan-reviewed-overlay.png`.

As imagens mais úteis para revisão são `12-plan-reviewed-overlay.png` (planta,
traços e 64 SF), `10-budget-saved-pending-quotes.png` (snapshot com preços
pendentes) e `06-mobile-photo-flow.png` (percurso anterior por foto em mobile).
A faixa OFFLINE permanece visível; nenhuma imagem representa produção.

Para reproduzir somente a geometria ou o orçamento com processos novos:

```powershell
powershell -NoProfile -File scripts/offline-browser-fixture.ps1 -Scenario geometry
powershell -NoProfile -File scripts/offline-browser-fixture.ps1 -Scenario budget
```

`budget` prepara primeiro a medida de fixture usando o cenário geometry;
`all` executa os três percursos. A execução aprovada usou os comandos Node por
etapa contra o mesmo servidor/perfil isolados. O launcher teve sua sintaxe
verificada; a suíte não foi repetida desnecessariamente só para testar o launcher.
