import {readFile,writeFile,copyFile,rename,access} from 'node:fs/promises';
import {constants} from 'node:fs';
// Patch the user's existing config, preserving DB, media, payment and auth settings.
const path='wrangler.json';
try{
 const source=await readFile(path,'utf8');let config;
 try{config=JSON.parse(source.replace(/^\uFEFF/,''));}catch{throw new Error('wrangler.json must contain valid JSON. No settings were changed. Add ai: { binding: "AI" } manually if using JSONC.');}
 if(config.ai?.binding&&config.ai.binding!=='AI')throw new Error('An AI binding with another name exists. No settings were changed; merge the binding manually.');
 if(config.env&&Object.keys(config.env).length)throw new Error('Named environments exist. No settings were changed; add the AI binding to the environment you deploy.');
 if(config.ai?.binding==='AI'){console.log('AI binding is already configured.');process.exit(0);}
 const backup='wrangler.before-rivo-ai.json';
 try{await access(backup);throw new Error('Backup already exists. Keep it safe and rename it before retrying.');}catch(e){if(e.code!=='ENOENT')throw e;}
 await copyFile(path,backup,constants.COPYFILE_EXCL);
 config.ai={...(config.ai||{}),binding:'AI'};
 const pending=path+'.rivo-ai.tmp';await writeFile(pending,JSON.stringify(config,null,2)+'\n',{flag:'wx'});await rename(pending,path);
 console.log('Added AI binding. Existing settings preserved. Backup: '+backup);
}catch(e){console.error(e.message);process.exitCode=1;}
