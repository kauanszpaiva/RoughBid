// Read-only model metadata. No prompts, uploaded documents, inference or account
// mutation. Credentials stay on the server and never enter the returned object.
// https://developers.openai.com/api/reference/resources/models/methods/retrieve
// https://platform.claude.com/docs/en/api/http/models/retrieve
// https://platform.moonshot.ai/docs/api/chat#list-models
// https://api-docs.deepseek.com/api/list-models/
const targets = [
  {provider:'openai',key:'OPENAI_API_KEY',model:'gpt-6-astra',url:'https://api.openai.com/v1/models/gpt-6-astra'},
  {provider:'claude',key:'ANTHROPIC_API_KEY',model:'claude-opus-5-5',url:'https://api.anthropic.com/v1/models/claude-opus-5-5'},
  {provider:'kimi',key:'KIMI_API_KEY',model:'kimi-k3',url:'https://api.moonshot.ai/v1/models'},
  {provider:'deepseek',key:'DEEPSEEK_API_KEY',model:'deepseek-flash',url:'https://api.deepseek.com/models'},
  {provider:'gemini',key:'GEMINI_API_KEY',model:'gemini-3.1-pro-preview',url:'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview'},
];
export async function probeProviderModelAccess(env=process.env,fetcher=fetch) {
  const providers=await Promise.all(targets.map(async target=>{
    const key=env[target.key]?.trim();
    const credentialConfigured=!!key&&!/masked|redacted|placeholder|changeme|^\[|^</i.test(key);
    const result={provider:target.provider,model:target.model,credentialConfigured,httpStatus:null,
      modelAvailable:false,inferenceVerified:false,status:'not_configured'};
    if(!credentialConfigured)return result;
    try {
      const headers=target.provider==='claude'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:target.provider==='gemini'?{'x-goog-api-key':key}:{authorization:`Bearer ${key}`};
      const response=await fetcher(target.url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(12000)});
      result.httpStatus=response.status;
      if(!response.ok)return {...result,status:'metadata_unavailable'};
      const value=await response.json();
      result.modelAvailable=target.provider==='gemini'
        ? value?.name===`models/${target.model}`&&value.supportedGenerationMethods?.includes('generateContent')===true
        : value?.id===target.model||Array.isArray(value?.data)&&value.data.some(model=>model?.id===target.model);
      return {...result,status:result.modelAvailable?'metadata_verified':'model_not_listed'};
    }catch{return {...result,status:'metadata_unavailable'};}
  }));
  return {providers,inferenceCalls:0,providerBalanceVerified:false};
}
