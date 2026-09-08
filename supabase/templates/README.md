# RoughBid — templates nativos do Supabase Auth

Artefatos preparados em 8 de setembro de 2026. Não foram aplicados remotamente nem enviados nesta auditoria. `prepare-auth-templates.mjs` gera os HTMLs e `auth-config.templates.json`; este último contém somente assuntos e conteúdo, sem credenciais ou alterações de políticas.

Os seis templates de autenticação cobrem confirmação, magic link, convite, recuperação, troca de email e reautenticação. Os sete de segurança cobrem alteração de senha/email/telefone, identidade vinculada/removida e MFA adicionado/removido. As notificações de segurança dependem das opções já habilitadas no projeto; o payload não as habilita.

Os botões preservam `{{ .ConfirmationURL }}` integralmente. Reautenticação usa `{{ .Token }}`. Troca de email usa `{{ .Email }}` e `{{ .NewEmail }}`; os demais campos específicos seguem a documentação oficial. Não substituir o link por uma rota inventada nem remover seus parâmetros.

## Antes de publicar

- A URL da logo deve responder 200 e `image/png`: `https://roughbid.vercel.app/brand/roughbid-logo-email.png`. Na verificação desta auditoria ainda respondia 404; a publicação do ativo está sendo tratada pela tarefa principal.
- Ler primeiro a configuração atual no Dashboard ou `GET https://api.supabase.com/v1/projects/piasgpciojstjalaqazu/config/auth`. Aplicar somente os campos do payload por PATCH, preservando SMTP, URLs e políticas. Guardar comparação dos campos sem senha SMTP.
- Confirmar SMTP personalizado Resend e domínio remetente verificado. A configuração documentada pelo Resend usa `smtp.resend.com`, porta 465, usuário `resend`, e chave Resend como senha. Nome: `RoughBid`; email remetente proposto, já utilizado no código: `hello@mail.kspdominion.group`. Não registrar a senha em arquivos ou logs. Desabilitar rastreamento de links de autenticação.
- Conferir Site URL e allowlist. O código atual de email retorna para `https://roughbid.vercel.app/app/` e preserva `invite` ou `pilot_invite` na query. O documento antigo que recomenda somente `/auth/callback` está desatualizado para esse fluxo. Preservar redirects existentes necessários e validar um link real de cada fluxo autorizado.

## O que foi verificado ao vivo

Projeto `piasgpciojstjalaqazu`, nome `RoughBid`, estado `ACTIVE_HEALTHY`. `/auth/v1/settings`: email habilitado, signup permitido, confirmação de email obrigatória (`mailer_autoconfirm:false`), Google desabilitado. Banco: 7 usuários, 7 emails confirmados, último login em `2026-09-08T20:56:33.504768Z`. `auth.audit_log_entries` tinha zero registros, inclusive no total; isso não prova ausência de eventos nem entrega SMTP.

O MCP disponível não expõe configuração Auth/SMTP ou logs de execução de Auth. CLI não está instalado e não há `SUPABASE_ACCESS_TOKEN` configurado; a pasta do CLI contém somente telemetria/traces. Portanto SMTP, remetente efetivo, templates hospedados e allowlist atuais não foram confirmados por esta auditoria. A tarefa principal pode conferi-los no Dashboard autenticado.

Atualização da tarefa principal no Dashboard: **SMTP personalizado não estava configurado**; Supabase exibia o aviso do serviço de email padrão destinado a testes. Separadamente, a tarefa principal verificou entrega pelo Resend da aplicação às `20:56:24Z` e login do proprietário às `20:56:33Z`. Portanto o fluxo principal Supabase Admin + Resend funciona, enquanto SMTP dos emails nativos requer configuração. A publicação dos templates nativos está sendo executada pela tarefa principal, sem presumir entrega SMTP.

O signup/login principal gera links por Supabase Admin e envia HTML pela API Resend da aplicação; os templates nativos não alteram esses emails. Além disso, não foi encontrada interface de recuperação de senha/troca de email no app. Templates prontos não certificam esses fluxos completos; a aplicação atualmente usa entrada sem senha.

## Fontes

- [Templates e variáveis Supabase](https://supabase.com/docs/guides/auth/auth-email-templates)
- [SMTP personalizado Supabase](https://supabase.com/docs/guides/auth/auth-smtp)
- [Resend com Supabase SMTP](https://resend.com/docs/send-with-supabase-smtp)
- [URLs de redirecionamento](https://supabase.com/docs/guides/auth/redirect-urls)
