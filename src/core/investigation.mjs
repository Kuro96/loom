const PREFIX='loom-investigation-';
export const investigationSessionId=id=>PREFIX+id;
export const isInvestigationSessionId=id=>typeof id==='string' && id.startsWith(PREFIX);
