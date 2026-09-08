# Diagnóstico seguro de falhas de IA

Antes desta correção, Gemini capturava e descartava erros do SDK; MultiProvider descartava novamente o erro. A API retornava uma mensagem 502 sem permitir distinguir falta de permissão, quota, modelo indisponível ou resposta inválida.

Agora cada falha identificada gera `ai_provider_failure` com referência UUID, provedor/modelo permitidos, etapa, código, status numérico original, motivo permitido e duração. O erro público e o registro do job contêm mensagem fixa e a mesma referência. Mensagem original, stack, chave, URL, PDF, nome de arquivo, escopo e resposta do provedor não são registrados. Falhas de contagem de tokens do piloto recebem a mesma proteção.

| Código | HTTP da aplicação | Ação operacional |
| --- | --- | --- |
| `provider_credentials` | 503 | Conferir chave/restrições; `API_KEY_REPORTED_LEAKED` identifica a mensagem exata de bloqueio documentada pelo Google. |
| `provider_permissions` | 503 | Conferir acesso ao serviço/projeto e faturamento. |
| `provider_quota` | 503 | Conferir quota disponível antes de repetir. |
| `provider_model_unavailable` | 503 | Conferir o modelo no projeto/API configurado. |
| `provider_timeout` | 504 | Conferir estado do job antes de repetir. |
| `provider_unavailable` | 503 | Indisponibilidade do fornecedor. |
| `provider_request_rejected` | 502 | Conferir parâmetros/compatibilidade do pedido. |
| `provider_invalid_output` / `provider_empty_output` | 502 | Resposta inválida ou sem achados utilizáveis; não foram inventadas quantidades. |

Nenhuma chave foi trocada, nenhum modelo/budget/retry/limite foi alterado, e não houve chamada de IA real nesta tarefa. A causa do incidente de produção só pode ser confirmada após publicação e uma execução autorizada que produza o novo diagnóstico.

As falhas foram exercitadas com SDKs injetados, incluindo 400/403/404/429/503, timeout, JSON inválido, segredo/PDF no erro e passagem por MultiProvider. Testes verificam que os campos proibidos não aparecem no log ou erro persistível.

Fontes: [erros e troubleshooting Google](https://ai.google.dev/gemini-api/docs/troubleshooting), [calendário de modelos](https://ai.google.dev/gemini-api/docs/deprecations). Consultado em 8 de setembro de 2026: `gemini-2.5-flash` não tem data de shutdown anunciada; não se conclui que o incidente seja aposentadoria do modelo.
