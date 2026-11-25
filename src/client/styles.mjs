export const styles = `
.loom-session-return{flex:none;min-height:28px;margin-inline-end:8px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:13px/20px var(--dsw-font-family);white-space:nowrap;cursor:pointer}
.loom-session-return:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.loom-root{--loom-bg:var(--dsw-alias-bg-base);--loom-panel:var(--dsw-alias-bg-layer-2);--loom-raised:var(--dsw-alias-bg-module-platform);--loom-border:var(--dsw-alias-border-l2);--loom-muted:var(--dsw-alias-label-secondary);--loom-text:var(--dsw-alias-label-primary);--loom-accent:var(--dsw-alias-brand-primary);container:loom / inline-size;display:flex;flex:1;flex-direction:column;height:100%;min-height:0;min-width:0;background:var(--loom-bg);color:var(--loom-text);font:14px/22px var(--dsw-font-family);color-scheme:inherit;overflow:hidden}
:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error),:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) *{box-sizing:border-box}
.loom-topbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;flex-shrink:0;min-width:0;padding:8px 12px;border-bottom:1px solid var(--loom-border);background:var(--loom-panel)}
.loom-brand{display:flex;gap:9px;align-items:center;min-width:0}
.loom-brand>span{font-size:18px;color:var(--loom-accent);line-height:1}
.loom-brand strong{display:block;letter-spacing:normal;font-size:16px}
.loom-brand small{font-size:12px;color:var(--loom-muted);letter-spacing:normal}

.loom-topbar>button{flex-shrink:0}
.loom-connection{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--loom-muted);margin-left:auto}
.loom-dot{width:6px;height:6px;background:var(--dsw-alias-state-success-primary);border-radius:50%}
.loom-dot-error{background:var(--dsw-alias-state-error-primary)}
:where(.loom-topbar,.loom-mobile-tabs,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) button{font:12px/18px var(--dsw-font-family);color:var(--loom-text);background:transparent;border:1px solid var(--loom-border);border-radius:var(--dsw-radius-sm);padding:4px 10px;min-height:28px;max-width:100%;cursor:pointer;overflow-wrap:anywhere}
:where(.loom-topbar,.loom-mobile-tabs,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.loom-mobile-tabs button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.loom-mobile-tabs>button{border-color:transparent;color:var(--loom-muted)}
.loom-mobile-tabs>button[aria-selected=true],.loom-mobile-tabs>button[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--loom-text)}
:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) button:focus-visible,:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) input:focus-visible,:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) select:focus-visible,:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) textarea:focus-visible,:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
:where(.loom-topbar,.loom-management,.loom-surface,.loom-session-controls,.loom-chat-header,.loom-bus-history,.loom-empty,.loom-global-messages,.loom-error) button:disabled{opacity:.45;cursor:not-allowed}
button.loom-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-button-primary-fill);font-weight:500}
button.loom-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}
button.loom-danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-on-color)}
button.loom-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-on-color)}
button.loom-danger-text{color:var(--dsw-alias-state-error-primary)}
.loom-topbar select,.loom-list-toolbar select,.loom-session-controls select,.loom-field input,.loom-field textarea,.loom-field select{width:100%;border:1px solid var(--loom-border);background:var(--dsw-alias-bg-layer-3);color:var(--loom-text);font:inherit;border-radius:var(--dsw-radius-sm);padding:6px 10px;min-height:34px;min-width:0}
.loom-field textarea{resize:vertical;line-height:1.6}
.loom-field input::placeholder,.loom-field textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.loom-field .loom-code-input{font-family:var(--ds-font-family-code);font-size:12px;tab-size:2}
.loom-split{display:flex;flex:1;min-height:0;min-width:0;overflow:hidden}
.loom-management{display:flex;flex:0 0 auto;width:clamp(320px,32cqi,360px);flex-direction:column;min-height:0;min-width:0;overflow:hidden;border-right:1px solid var(--loom-border);container:loom-rail / inline-size}
.loom-split[data-rail-collapsed="true"] > .loom-management{display:none}
.loom-mobile-tabs{display:none}
.loom-project-nav{position:relative;z-index:2;display:flex;gap:6px;flex-shrink:0;min-width:0;padding:8px 10px;border-bottom:1px solid var(--loom-border);background:var(--loom-panel)}
.loom-project-nav>button{white-space:nowrap}
.loom-project-nav button[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--loom-text);font-weight:500}
.loom-project-trigger{display:flex;align-items:center;gap:8px;min-width:0}
.loom-project-trigger>span:first-child{overflow:hidden;text-overflow:ellipsis}
.loom-project-picker{position:absolute;inset:100% 10px auto;padding:8px;border:1px solid var(--loom-border);border-radius:var(--dsw-radius-sm);background:var(--loom-panel);display:flex;flex-direction:column;max-height:45vh;color:var(--loom-text)}
.loom-project-picker input{width:100%;min-width:0;min-height:32px;border:1px solid var(--loom-border);border-radius:var(--dsw-radius-sm);padding:4px 8px;background:var(--loom-raised);color:var(--loom-text);font:inherit}
.loom-project-options{margin:4px 0 0;padding:0;list-style:none;overflow:auto;min-height:0}
.loom-project-options button{width:100%;text-align:left;border-color:transparent}
.loom-project-picker p{margin:4px 0 0;color:var(--loom-muted)}
.loom-tabs{display:flex;gap:2px;padding:7px 10px;border-bottom:1px solid var(--loom-border);flex-shrink:0;background:var(--dsw-alias-bg-base)}
.loom-tabs>button{background:transparent;border-color:transparent;border-radius:var(--dsw-radius-sm);white-space:nowrap;padding:7px 10px;font-size:12px;color:var(--loom-muted)}
.loom-tabs>button[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);border-color:transparent}
.loom-list-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:10px 12px;flex-shrink:0;min-width:0}
.loom-list-toolbar select{flex:1 1 88px;width:0;font-size:12px;padding:6px;min-width:0}
.loom-list-toolbar>strong{flex:1}
.loom-list-toolbar>button{white-space:nowrap}
.loom-status-filter{flex-shrink:0;padding:8px 12px 0;font-size:12px;min-width:0}
.loom-filter-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--loom-muted)}
.loom-filter-heading>div{display:flex;gap:4px}
.loom-filter-heading button{border-color:transparent;padding:2px 6px;color:var(--loom-muted)}
.loom-filter-options{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px}
.loom-filter-options label{display:flex;align-items:center;gap:5px;min-height:28px;cursor:pointer;white-space:nowrap}
.loom-filter-options input{margin:0;accent-color:var(--loom-accent)}
.loom-list-scroll{flex:1;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable}
.loom-work-list{min-width:0;padding:0 8px 8px}
.loom-panel-header{display:flex;align-items:center;gap:8px;flex-shrink:0;min-width:0;padding:8px 12px;border-bottom:1px solid var(--loom-border)}
.loom-group-title{font-size:12px;letter-spacing:normal;color:var(--loom-muted);margin:7px 5px}
.loom-management .loom-work-row{display:flex;justify-content:space-between;gap:10px;align-items:center;width:100%;background:transparent;border:1px solid transparent;text-align:left;padding:8px;margin:2px 0}
.loom-work-row>div{min-width:0;flex:1}
.loom-decision-row{display:flex;align-items:center;gap:6px}
.loom-decision-row>.loom-work-row,.loom-request-summary{min-width:0;flex:1}
.loom-decision-row>button:last-child{flex-shrink:0}
.loom-request-summary{padding:8px}
.loom-request-summary strong,.loom-request-summary small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.loom-request-summary small{color:var(--loom-muted);margin-top:4px}
.loom-work-row strong{display:block;font-size:12px;font-weight:500;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.loom-work-row small{display:block;font-size:12px;color:var(--loom-muted);text-overflow:ellipsis;white-space:nowrap;overflow:hidden;margin-top:4px}
.loom-management .loom-work-row.selected{background:var(--dsw-specific-sidebar-nav-item-active);border-color:transparent}
.loom-badge{display:inline-flex;align-items:center;flex-shrink:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);padding:2px 6px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;background:var(--dsw-alias-bg-module-platform)}
.loom-status-awaiting_model,.loom-status-review{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-color:var(--dsw-alias-state-warn-primary)}
.loom-status-running,.loom-status-dispatching,.loom-status-active{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);border-color:var(--dsw-alias-state-business-primary)}
.loom-status-accepted,.loom-status-completed{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-success-tertiary);border-color:var(--dsw-alias-border-l1)}
.loom-status-failed{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary)}
.loom-status-cancelled,.loom-status-paused{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.loom-status-cancel_requested,.loom-status-pause_requested{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.loom-pagination,.loom-load-more{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--loom-muted)}
.loom-pagination small{color:var(--loom-muted);font-size:12px}
.loom-pagination button{padding:3px 8px;font-size:12px}
.loom-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:6px 0}
.loom-detail-scroll{flex:1;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable}
.loom-detail{padding:16px;min-width:0}
.loom-detail h2,.loom-surface>header h2{font-size:16px;margin:0 0 8px;line-height:1.45;font-weight:500;word-break:break-word}
.loom-detail h3,.loom-surface:not(.loom-page-reader) h3{font-size:12px;font-weight:500;margin:14px 0 7px}
.loom-detail-header{display:flex;gap:10px;justify-content:space-between;align-items:flex-start;min-width:0}
.loom-detail-header>div{min-width:0;flex:1}
.loom-detail-header small{color:var(--loom-muted);font-size:12px;letter-spacing:normal}
.loom-description{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;color:var(--dsw-alias-label-primary);font-size:12px;margin:8px 0 12px}
.loom-meta{display:grid;grid-template-columns:65px minmax(0,1fr);font-size:12px;line-height:1.7;gap:4px 8px;margin:10px 0 14px}
.loom-meta dt{color:var(--loom-muted)}
.loom-meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
.loom-detail details,.loom-surface details{border-top:1px solid var(--loom-border);padding:9px 0;margin-top:8px}
.loom-detail summary,.loom-surface summary,.loom-bus-history summary{cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px}
.loom-id{font-size:12px;overflow-wrap:anywhere;color:var(--loom-muted);font-family:var(--ds-font-family-code)}
.loom-field{display:flex;flex-direction:column;gap:5px;margin:10px 0}
.loom-field>span{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.loom-field small,.loom-hint{font-size:12px;color:var(--loom-muted);line-height:1.55;overflow-wrap:anywhere}
.loom-model-picker{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;min-width:0;margin-block:10px}
.loom-model-picker>.loom-field{flex:4 1 13rem;min-width:0;margin:0}
.loom-model-picker>.loom-field+.loom-field{flex:1 1 7rem}
.loom-card{border:0;background:transparent;min-width:0;padding:8px 0;margin:8px 0}
.loom-card .loom-field{margin:0}
.loom-stage{min-width:0;border:0;border-top:1px solid var(--loom-border);padding:12px 0;margin:0}
.loom-stage header{display:flex;gap:10px;justify-content:space-between;align-items:center}
.loom-stage header strong{font-size:12px}
.loom-stage header small{font-size:12px;color:var(--loom-muted)}
.loom-authorization{min-width:0;border:0;border-top:1px solid var(--loom-border);padding:14px 0;margin:16px 0 0}
.loom-authorization>p{font-size:12px;color:var(--dsw-alias-label-secondary)}
.loom-checkbox{display:flex;align-items:flex-start;gap:9px;font-size:12px;line-height:1.6;margin:14px 0}
.loom-checkbox input{accent-color:var(--dsw-alias-brand-primary);margin-top:3px;flex-shrink:0}
.loom-management .loom-managed-row{justify-content:flex-start;cursor:pointer}
.loom-managed-row small{white-space:normal;overflow-wrap:anywhere}
.loom-managed-row:has(input:checked){background:var(--dsw-specific-sidebar-nav-item-active)}
.loom-blockers{background:var(--dsw-alias-state-warn-tertiary);border:1px solid var(--dsw-alias-state-warn-primary);padding:8px 12px;border-radius:var(--dsw-radius-sm);margin:10px 0;font-size:12px;color:var(--dsw-alias-label-primary)}
.loom-blockers h3{margin:0}
.loom-blockers ul{margin:6px 0;padding-left:16px}
.loom-warning{font-size:12px;background:var(--dsw-alias-state-warn-tertiary);border-left:3px solid var(--dsw-alias-state-warn-primary);padding:9px 12px;color:var(--dsw-alias-label-primary)}
.loom-json{font:12px/1.6 var(--ds-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:10px;margin:8px 0;color:var(--dsw-alias-label-primary)}
.loom-subtabs{display:flex;gap:6px;margin-top:14px}
.loom-subtabs button{font-size:12px}
.loom-detail>.loom-subtabs>button{flex:1;font-size:13px;min-height:32px}
.loom-subtabs button[aria-selected=true]{border-color:transparent;color:var(--dsw-alias-label-primary)}
.loom-evidence details{margin:0}
.loom-settings form+form{border-top:1px solid var(--loom-border);margin-top:20px;padding-top:8px}
.loom-global-messages{max-height:170px;overflow:auto;flex-shrink:0}
.loom-error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);padding:9px;margin:8px;min-width:0}
.loom-error pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--ds-font-family-code);margin:0}
.loom-error button{font-size:12px}
.loom-success{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-label-primary);font-size:12px;padding:8px 12px;margin:0;display:flex;justify-content:space-between;align-items:center}
.loom-success button{background:transparent;border:0;padding:0 5px}
.loom-chat{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;position:relative;overflow:hidden;background:var(--dsw-alias-bg-base)}
.loom-chat-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;flex-shrink:0;min-width:0;padding:8px 12px;border-bottom:1px solid var(--loom-border)}
.loom-session-tabs{display:flex;gap:6px;min-width:0;overflow-x:auto;overflow-y:hidden}
.loom-session-tabs button{font-size:12px;max-width:210px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:transparent;border-color:transparent}
.loom-session-tabs button[aria-selected=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-sidebar-nav-item-active);border-color:transparent}
.loom-chat-header>button{font-size:12px;flex-shrink:0}
.loom-session-controls{display:flex;align-items:center;gap:6px;min-width:0;flex-shrink:0;padding:7px 12px}
.loom-chat-header>.loom-session-controls{flex:1;min-width:min(100%,220px);padding:0}
.loom-chat-header>select{flex:1;min-width:0;width:0;background:var(--dsw-alias-bg-module-platform);border:0;border-radius:var(--dsw-radius-sm);color:var(--loom-text);font:13px/20px var(--dsw-font-family);padding:6px 8px}
.loom-session-controls select{flex:1;width:0;font-size:12px;padding:5px}
.loom-session-controls button{font-size:12px;white-space:nowrap;padding:4px 7px}
.loom-conversation-body{display:flex;flex:1;min-height:0;min-width:0;position:relative;overflow:hidden}
.loom-conversation-body[hidden]{display:none}
.loom-page{position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;background:var(--loom-bg);container:loom-surface / inline-size}
.loom-page>header>button{flex:none}
.loom-page-body{flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain}
.loom-page:not(.loom-page-reader) .loom-page-body>form{width:100%;max-width:52rem;margin-inline:auto}
.loom-page-reader .loom-page-body:has(.loom-native-document){overflow:hidden}
.loom-document:has(>.loom-native-document){display:flex;flex-direction:column;height:100%;padding:0}
.loom-native-document{display:flex;flex:1;min-height:0;min-width:0;overflow:hidden}

.loom-chat-footer{display:flex;align-items:center;gap:9px;padding:5px 10px;border-top:1px solid var(--loom-border);font-size:12px;color:var(--dsw-alias-label-tertiary);min-width:0}
.loom-chat-footer code{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.loom-bus-history{padding:5px 10px;max-height:100px;overflow:auto}
.loom-bus-history button{display:block;font-size:12px;margin:3px 0}

.loom-empty{padding:20px 16px;text-align:center;color:var(--loom-muted);font-size:13px;min-width:0;max-width:100%;overflow-wrap:anywhere}
.loom-empty h2{font-size:16px;color:var(--loom-text);font-weight:500}
.loom-empty p{font-size:12px;line-height:1.8}
.loom-empty-icon{font-size:24px;color:var(--dsw-alias-brand-primary)}
.loom-work-list .loom-empty{padding:18px 12px;font-size:12px}
.loom-conversation-body>.loom-empty{margin:auto;max-width:440px}
.loom-dialog{--loom-panel:var(--dsw-alias-bg-layer-2);--loom-raised:var(--dsw-alias-bg-module-platform);--loom-border:var(--dsw-alias-border-l2);--loom-muted:var(--dsw-alias-label-secondary);--loom-text:var(--dsw-alias-label-primary);--loom-accent:var(--dsw-alias-brand-primary);container:loom-surface / inline-size;background:var(--loom-panel);color:var(--loom-text);border:1px solid var(--loom-border);border-radius:var(--dsw-radius-lg);padding:0;margin:auto;width:min(640px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;box-shadow:var(--dsw-elevation-prominent);font:14px/22px var(--dsw-font-family);color-scheme:inherit}
.loom-dialog::backdrop{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.loom-dialog>header{display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);padding:15px 20px;z-index:1}
.loom-surface>header h2{margin:0}
.loom-document{min-width:0;padding:clamp(12px,3vw,32px);overflow-wrap:anywhere}
.loom-document article{max-width:78ch;margin-inline:auto}
.loom-html-document{display:block;width:100%;height:100%;border:0}
.loom-document[data-kind=text] pre{white-space:pre-wrap}
.loom-dialog>form,.loom-page:not(.loom-page-reader) .loom-page-body{padding:12px 20px 20px}
.loom-dialog>form{overflow-wrap:anywhere}
.loom-surface footer{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;border-top:1px solid var(--loom-border);margin-top:16px;padding:10px 0;background:var(--loom-panel)}
@media(min-height:420px){:is(.loom-dialog,.loom-page-body)>form>footer{position:sticky;bottom:0;z-index:1}.loom-dialog{scroll-padding-block:58px 76px}.loom-page-body{scroll-padding-block-end:76px}}
.loom-decision-steps{padding-inline-start:1.6em;margin:10px 0;font-size:13px;overflow-wrap:anywhere}
.loom-decision-steps>li{padding:4px 0}.loom-decision-steps>li>dl.loom-summary{margin:2px 0;padding:0}
.loom-stage-inputs{margin:12px 0;padding:8px 12px;border-inline-start:2px solid var(--loom-border);background:var(--loom-raised)}
.loom-stage-inputs>h4{font-size:13px;font-weight:500;margin:0 0 4px}
.loom-stage-inputs>dl.loom-summary{margin:0;padding:0}
.loom-surface .loom-error{margin:12px 0}

.loom-surface .loom-checkbox{padding:0;border:0;background:transparent}
.loom-topbar,.loom-management,.loom-chat-header,.loom-session-controls,.loom-bus-history,.loom-chat-footer,.loom-global-messages{color-scheme:inherit}
.loom-conversation-body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);color-scheme:inherit}
.loom-conversation-body>.loom-empty{color:var(--dsw-alias-label-secondary)}
.loom-conversation-body>.loom-empty h2{color:var(--dsw-alias-label-primary)}

.loom-tabs,.loom-subtabs{overflow-x:auto}
.loom-topbar select,.loom-list-toolbar select,.loom-session-controls select,.loom-field select{background:var(--dsw-alias-bg-module-platform);border-color:transparent;color-scheme:inherit;text-overflow:ellipsis}
.loom-subtabs button[aria-selected=true]{background:var(--dsw-specific-sidebar-nav-item-active)}
.loom-subtabs button[aria-pressed=true]{background:var(--dsw-specific-sidebar-nav-item-active);border-color:transparent;color:var(--loom-text)}
.loom-read-only{white-space:nowrap;font-size:12px;color:var(--loom-muted)}
.loom-brand strong{font-size:14px;font-weight:500}
.loom-brand>span,.loom-empty-icon{color:var(--loom-muted)}
.loom-detail h3,.loom-surface h3{font-size:14px;line-height:22px}
.loom-field{min-width:0}
.loom-field>span{font-size:13px;font-weight:400}
.loom-description,.loom-work-row strong{font-size:13px}
.loom-dialog>header>button{width:28px;height:28px;padding:0;border-color:transparent;font-size:18px}
.loom-page-body>form>footer{background:var(--loom-bg)}
.loom-settings{min-width:0;margin:0 auto;width:100%}
.loom-page-body:has(>.loom-settings){scroll-padding-block:6px;scrollbar-gutter:stable}
.loom-settings-save{white-space:nowrap}
.loom-settings-status{min-width:0;overflow-wrap:anywhere;font-size:12px;color:var(--loom-muted)}
.loom-settings-section{padding:16px 0;border-bottom:1px solid var(--loom-border)}
.loom-settings-section:last-child{border-bottom:0}
.loom-settings-section>h3{margin:0 0 12px}
.loom-setting-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;min-width:0}
.loom-setting-label{flex:1;min-width:0;font-size:14px;line-height:22px;color:var(--loom-text)}
.loom-setting-label>strong{font-weight:400}
.loom-setting-control{flex:0 1 60%;min-width:0}
.loom-setting-control>.loom-field{margin:0}
.loom-setting-row>.loom-model-picker{flex:1;width:100%}
input.loom-setting-control[type=checkbox]{flex:none;width:16px;height:16px;align-self:center;accent-color:var(--dsw-alias-brand-primary)}
.loom-setting-control :is(input:not([type=checkbox]),textarea,select){box-sizing:border-box;width:100%;min-width:0;min-height:34px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--loom-text);font:inherit;font-size:13px;color-scheme:inherit}
.loom-setting-control select{background:var(--dsw-alias-bg-module-platform);border-color:transparent}
.loom-setting-control input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px}
.loom-setting-hint{font-size:12px;color:var(--loom-muted);line-height:18px;overflow-wrap:anywhere;margin:4px 0 0}
.loom-detail .loom-advanced,.loom-surface .loom-advanced{border:0;padding:0;margin:12px 0}
.loom-advanced>summary{color:var(--loom-muted);font-size:12px}
.loom-advanced[open]>summary{margin-bottom:12px}
.loom-advanced>.loom-setting-row+.loom-setting-row{border-top:1px solid var(--loom-border)}
.loom-usage{min-width:0;overflow-wrap:anywhere;--loom-usage-input:var(--dsw-alias-state-business-tertiary);--loom-usage-hit:var(--dsw-alias-state-business-primary);--loom-usage-output:var(--dsw-alias-state-success-primary)}
.loom-usage-heading,.loom-usage-legend{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px}
.loom-usage-heading{justify-content:space-between}
.loom-usage-legend{color:var(--loom-muted);font-size:12px;margin:4px 0 8px}
.loom-usage-legend span{display:inline-flex;align-items:center;gap:4px}
.loom-usage-legend i{width:10px;height:10px}
.loom-usage-hit{background:var(--loom-usage-hit)}
.loom-usage-miss{background:var(--loom-usage-input);box-shadow:inset 0 0 0 1px var(--loom-border)}
.loom-usage-unknown{background:repeating-linear-gradient(135deg,var(--loom-muted) 0 1px,var(--loom-raised) 1px 4px)}
.loom-usage-output{background:var(--loom-usage-output)}
.loom-usage-chart{margin:8px 0 14px}
.loom-usage-plot{--loom-usage-bands:108px 62px 14px;display:grid;grid-template-columns:minmax(46px,auto) minmax(0,1fr);gap:0 6px}
.loom-usage-axes,.loom-usage-column{display:grid;grid-template-rows:var(--loom-usage-bands);row-gap:5px}
.loom-usage-axes{font-size:11px;text-align:end;color:var(--loom-muted)}
.loom-usage-axes>div{display:flex;flex-direction:column;justify-content:space-between;line-height:1.15}
.loom-usage-columns{display:grid;min-width:0;gap:1px}
.loom-usage-plot button.loom-usage-column{display:grid;min-width:0;border:0;border-radius:0;padding:0;position:relative}
.loom-usage-plot button.loom-usage-column:focus-visible,.loom-usage-plot button.loom-usage-column[aria-pressed=true]{box-shadow:inset 0 0 0 1px var(--loom-usage-hit);outline-offset:-1px;z-index:1}
.loom-usage-bar{display:flex;min-width:0;flex-direction:column-reverse;align-items:center;border-bottom:1px solid var(--loom-border)}
.loom-usage-bar>span{width:75%;max-width:36px;flex:none}
.loom-usage-bar>.loom-usage-missing{height:1px;border-bottom:1px dashed var(--loom-muted)}
.loom-usage-review-dot{place-self:center;width:min(6px,90%);aspect-ratio:1;border-radius:50%;background:var(--loom-text)}
.loom-usage-time{grid-column:2;display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 6px;font-size:11px;color:var(--loom-muted)}
.loom-usage-list,.loom-usage-calls{margin:4px 0;padding:0;list-style:none}
.loom-usage-row,.loom-usage-calls li{border-top:1px solid var(--loom-border);padding:8px 0}
.loom-usage-row p,.loom-usage-row h4,.loom-usage-calls p{margin:4px 0}
.loom-usage-metrics{display:flex;flex-wrap:wrap;gap:4px 14px;margin:4px 0;font-size:12px}
.loom-usage-metrics dd{margin:0;font-variant-numeric:tabular-nums}
.loom-usage-metrics dt{color:var(--loom-muted)}
.loom-summary{min-width:0;padding:8px 0;overflow-wrap:anywhere}
dl.loom-summary,.loom-check-row dl{display:grid;grid-template-columns:80px minmax(0,1fr);gap:6px 10px;font-size:13px;margin:8px 0}
.loom-summary dt,.loom-check-row dt{color:var(--loom-muted)}
.loom-summary dd,.loom-check-row dd{min-width:0;margin:0;overflow-wrap:anywhere}
.loom-detail .loom-coordination>.loom-summary{grid-template-columns:65px minmax(0,1fr);padding:4px 0;gap:5px 8px}
.loom-coordination .loom-warning,.loom-coordination-receipt{margin:6px 0 8px;padding:8px 10px;border-radius:var(--dsw-radius-sm);overflow-wrap:anywhere}
.loom-coordination .loom-warning{border:1px solid var(--dsw-alias-state-warn-primary)}
.loom-coordination-receipt{background:var(--dsw-alias-state-success-tertiary);color:var(--loom-text);font-size:13px}
.loom-coordination h4{margin:10px 0 4px;font-size:13px;font-weight:500}
.loom-coordination time{font-variant-numeric:tabular-nums}
.loom-coordination a,.loom-coordination button.loom-coordination-link,.loom-attention-action{color:var(--dsw-alias-link)}
.loom-coordination button.loom-coordination-link{border-color:transparent;padding-inline:3px;text-align:start}
.loom-management .loom-work-row:has(>.loom-attention-action) small{white-space:normal;overflow-wrap:anywhere}
.loom-attention-action{flex:0 0 auto;max-width:8em;font-size:12px;text-align:end}
.loom-result{min-width:0;padding:12px 0;border-top:1px solid var(--loom-border);overflow-wrap:anywhere}
.loom-result p{white-space:pre-wrap;font-size:13px;line-height:21px}
.loom-inline-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));align-items:start;gap:8px 12px;min-width:0}
.loom-inline-fields>.loom-field{margin:4px 0}
.loom-inline-fields>button{justify-self:start;align-self:end;margin-bottom:4px}
.loom-check-list{list-style:none;padding:0;margin:8px 0;min-width:0}
.loom-check-list>li{padding:8px 0;border-bottom:1px solid var(--loom-border);font-size:13px;overflow-wrap:anywhere}
.loom-check-row{min-width:0;border:0;border-bottom:1px solid var(--loom-border);padding:12px 0;margin:0}
.loom-check-row>header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.loom-stage-editor{min-width:0;min-inline-size:0;border:0;border-top:1px solid var(--loom-border);padding:12px 0;margin:12px 0}
.loom-stage-editor>header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.loom-stage-editor legend{padding:0;font-size:14px;font-weight:500}
.loom-stage-editor fieldset{min-inline-size:0;border:0;padding:0;margin:12px 0}
.loom-stage-editor fieldset legend{font-size:13px;font-weight:400}
.loom-arguments{min-width:0;display:flex;flex-direction:column;gap:8px;padding:4px 0;margin:8px 0;font-size:13px}
.loom-arguments>.loom-inline-fields{display:flex;align-items:center;gap:8px}
.loom-arguments>.loom-inline-fields>input,.loom-arguments>.loom-inline-fields>.loom-field{flex:1;min-width:0}
.loom-arguments>.loom-inline-fields>button{flex:0 0 auto;align-self:center;margin:0}
.loom-arguments>button{align-self:flex-start}
.loom-arguments>li{min-width:0;overflow-wrap:anywhere}
ol.loom-arguments{display:block;padding-left:20px}
.loom-check-row>div:first-child{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.loom-check-row h4{font-size:13px;font-weight:500;margin:4px 0 8px}
.loom-arguments code,.loom-check-row code{font:12px/19px var(--ds-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere}
.loom-use-list{min-width:0}

dl.loom-summary:has(>.loom-value-row){display:flex;flex-direction:column;gap:8px}
.loom-value-row{display:grid;min-width:0;gap:2px}
.loom-value-row>dd>.loom-value:first-child{font-weight:500}
.loom-value{white-space:pre-wrap;overflow-wrap:anywhere}
.loom-step-input{min-width:0;padding:4px 0;margin:8px 0;overflow-wrap:anywhere}
.loom-step-input h4{margin:2px 0 6px;font-size:13px;font-weight:500}
.loom-step-input .loom-summary{margin:0;padding:2px 0}
.loom-step-input+.loom-step-input{border-top:1px solid var(--loom-border);padding-top:10px}
.loom-run-field:has(>.loom-field+.loom-field){display:grid;grid-template-columns:minmax(0,1fr) minmax(8em,32%);align-items:start;gap:8px}
button.loom-format-toggle{color:var(--loom-muted);border-color:transparent;font-size:12px;padding-inline:0}
@container loom-rail (max-width:460px){.loom-setting-row:not(:has(>input[type=checkbox])){align-items:stretch;flex-direction:column;gap:8px}
.loom-setting-control:not([type=checkbox]){flex:auto;width:100%}
.loom-detail{padding:12px}
}
@container loom-surface (max-width:480px){
.loom-run-field:has(>.loom-field+.loom-field){grid-template-columns:minmax(0,1fr)}
.loom-setting-row:not(:has(>input[type=checkbox])){align-items:stretch;flex-direction:column;gap:8px}
.loom-setting-control:not([type=checkbox]){flex:auto;width:100%}
.loom-surface>header{padding:10px 12px}
.loom-dialog>form,.loom-page:not(.loom-page-reader) .loom-page-body{padding:10px 12px 16px}
.loom-inline-fields{grid-template-columns:minmax(0,1fr)}
.loom-surface footer>button{flex:1}
}
@container loom (max-width:760px){
.loom-rail-toggle{display:none}
.loom-mobile-tabs:not([hidden]){display:flex;flex-shrink:0;gap:4px;padding:6px 12px;border-bottom:1px solid var(--loom-border)}
.loom-mobile-tabs>button{flex:1}
.loom-topbar{gap:8px;padding:8px 12px}
.loom-topbar>select{max-width:none}
.loom-split:not([data-mobile-pane="work"]) > .loom-management{display:none}
.loom-split[data-mobile-pane="work"] > .loom-chat{display:none}
.loom-split[data-mobile-pane="work"] > .loom-management{display:flex;flex:1;width:auto;border-right:0}
}
`;
