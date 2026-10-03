# QA visual offline: propostas automáticas — 03/10/2026

**17/17 verificações novas aprovadas: 8 de planta e 9 de foto planar**, zero exceções não capturadas, zero
requisições externas observadas e zero chamadas pagas. Os 34 asserts da rodada
anterior permanecem registrados em seus próprios relatórios e não foram repetidos.

O harness importa os componentes reais do produto e usa um PDF sintético de uma
folha, autenticação fictícia e APIs/storage/jobs simulados. O processo Chrome
headless tem perfil próprio, DNS externo bloqueado e interceptação CDP antes da
navegação; todas as imagens trazem a faixa OFFLINE. Vite carrega apenas seu
`envDir` vazio com constantes públicas fictícias. Não são lidas credenciais locais.

## Percurso executado

1. `PlansPage`: reserva, upload e conclusão do PDF sintético, seleção Full V2,
   gravação de job durável simulado e recuperação do resultado salvo.
2. O painel de revisão consulta propostas do arquivo e da folha correspondentes.
   A geometria do fornecedor tem coordenadas próprias e a UI declara que ela não
   está alinhada ao PDF. Cobertura completa continua pendente.
3. Uma proposta de cômodo conserva a área SI original de **5,94579456 m²**.
   Confirmar sem verificar geometria/identidade/duplicatas não dispara POST.
   Após confirmação explícita, o POST envia decisão, nota, revisão e chave de
   request; não envia quantidade nem exige inserir escala ou medida manual.
4. Uma segunda proposta, de superfície de objeto, é rejeitada pelo caminho de
   correção. Seu valor não é acrescentado à área do cômodo.
5. Só a geometria confirmada chega ao orçamento: conversão única para **64 SF**,
   composição compatível, snapshot salvo e preços/total pendentes. Nada exibe
   US$0 como preço faltante. O papel viewer não salva orçamento.

As propostas agora são geradas no Node local pela função real de produção
`kamaiCandidates`, incluindo IDs SHA-256, proveniência e bloqueio de medidas
ausentes. Ela recebe um checkpoint upstream sintético; não chama Kamai. As
medidas SI continuam preservadas, apesar de o fixture declarar uma escala de
desenho 1:50. A presença dessa escala não altera as medidas SI.

Esses checks provam integração visual e contratos cliente/API. A geometria/área
SI upstream, o job do fornecedor e a persistência do orçamento são simulados:
esta rodada não prova extração Kamai real, alinhamento de página, SQL/RLS,
worker/Redis remoto, precisão de IA, preço varejista ou disponibilidade da conta.
Testes locais do backend de produção são provas separadas no pacote.

## Foto planar executada

`PhotoTakeoffPanel` e `PhotoPlanarReview` reais executaram upload de um PNG
sintético de 800 × 600 px, job simulado, verificação SHA-256 do preview e revisão.
Sem referência, a quantidade fica indeterminada. Selecionar o método planar
retira o campo de quantidade pronta: o cliente envia `quantity: null`.

Quatro pontos ligados à revisão/hash da imagem e duas dimensões conhecidas de
fixture — 10 × 12 ft — são enviados para a função **real, local e pura
`reviewPhotoEvidence`**. Ela valida a calibração e calcula **120 SF**. A falta
das confirmações de retângulo, lente, plano e contorno impede o POST. Traçar
metade da região recalcula **60 SF**, incrementa a revisão para 2 e conserva
uma única medida aceita. Reload recupera a quantidade e seus `planarProofs`.
O orçamento recebe 60 SF com a prova e mantém preço/total pendentes.

A interface declara que o resultado é condicional à calibração e cobre apenas
a região marcada; incerteza estatística e revisão independente continuam
pendentes. Os valores 10 × 12 ft são dados do teste, não uma medida real da foto.
Não há dedução de escala por EXIF, confiança da IA ou tamanho típico de objetos.
O viewport de 390 × 844 px passou sem overflow horizontal.

## Artefatos e reprodução

Em `../deliverables/offline-browser/`:

- `offline-browser-automatic-report.json`: 8 asserts, destinos, requests e horários.
- `offline-automatic-plan.pdf`: fonte sintética de uma folha.
- `20-automatic-geometry-confirmed.png`: proposta, SI, preview e decisão.
- `21-automatic-geometry-budget.png`: resultado selecionado e preço pendente.
- `offline-browser-photo-planar-report.json`: 9 asserts de foto planar.
- `22-photo-planar-calibration.png`: referência e contorno.
- `23-photo-planar-mobile-result.png`: 60 SF recuperados em viewport 390 × 844.
- `24-photo-planar-mobile-calibration-and-result.png`: captura de apresentação
  longa, 390 × 1800, com imagem, referência, contorno e resultado condicional.
- `25-automatic-source-and-reviewed-result.png`: captura de apresentação com
  preview do fornecedor e estados aceito/rejeitado/bloqueado.

As duas capturas de apresentação têm relatórios próprios, sem novos asserts;
não aumentam os 17 testes. Sugestão de três imagens para revisar:
`25-automatic-source-and-reviewed-result.png`, `21-automatic-geometry-budget.png`
e `24-photo-planar-mobile-calibration-and-result.png`.

Execução aprovada: `node scripts/offline-browser-fixture.automatic-qa.mjs` contra
Vite/Chrome locais exclusivos. Para iniciar processos novos no Windows:

```powershell
powershell -NoProfile -File scripts/offline-browser-fixture.ps1 -Scenario automatic
powershell -NoProfile -File scripts/offline-browser-fixture.ps1 -Scenario photo-planar
```

O launcher recusa portas ocupadas, usa processos ocultos e encerra somente os
processos próprios. Não utiliza APIs reais nem inicia cobranças.
O cenário photo-planar gera seu próprio PNG de fixture, sem depender de artefatos
da rodada anterior. Os componentes principais não foram alterados pelo agente QA.
