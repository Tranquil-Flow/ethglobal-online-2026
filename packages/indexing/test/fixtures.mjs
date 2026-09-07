import {digestOf} from '../../contracts/index.mjs';
export const providerId='synthetic.eth';
export const receipt={version:'1',kind:'receipt',objectDigest:digestOf('synthetic-receipt'),receiptDigest:digestOf('synthetic-receipt'),providerKey:digestOf(providerId),mode:'development'};
export const assessment={version:'1',assessmentId:'synthetic-assessment',receiptDigest:receipt.receiptDigest,method:'synthetic-method',profileId:digestOf('synthetic-profile'),verifierId:'unknown-verifier',outcome:'passed',mode:'development',createdAt:'2026-01-01T00:00:00.000Z'};
export const event={version:'1',kind:'assessment',objectDigest:digestOf(assessment),receiptDigest:receipt.receiptDigest,providerKey:receipt.providerKey,mode:'development',outcome:assessment.outcome,verifierKey:digestOf(assessment.verifierId),methodKey:digestOf(assessment.method),assessment};
