import { Component, Input, OnInit } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { HagisWorkspace } from '../models'

export interface HagisSaveWorkspaceResult {
    id?: string
    name: string
    customer?: string
    description?: string
}

/** 현재 화면을 워크스페이스로 저장 */
@Component({
    template: `
<div class="modal-header">
    <h5 class="m-0">현재 화면을 워크스페이스로 저장 <small class="text-muted">hagis by tabby</small></h5>
</div>
<div class="modal-body">
    <div class="mb-3">
        <label class="form-label">저장 방식</label>
        <select class="form-select" [(ngModel)]="targetId" (ngModelChange)="onTargetChange()">
            <option [ngValue]="null">새 워크스페이스</option>
            <option *ngFor="let ws of workspaces" [ngValue]="ws.id">덮어쓰기: {{ ws.customer ? ws.customer + ' · ' : '' }}{{ ws.name }}</option>
        </select>
    </div>
    <div class="mb-3">
        <label class="form-label">고객사</label>
        <input class="form-control" [(ngModel)]="customer" list="hagis-customers" placeholder="예: A사 본사">
        <datalist id="hagis-customers">
            <option *ngFor="let c of customers" [value]="c"></option>
        </datalist>
    </div>
    <div class="mb-3">
        <label class="form-label">워크스페이스 이름</label>
        <input class="form-control" [(ngModel)]="name" placeholder="예: 코어 스위치 정기 점검" (keyup.enter)="ok()" autofocus>
    </div>
    <div class="mb-1">
        <label class="form-label">메모 (선택)</label>
        <input class="form-control" [(ngModel)]="description" placeholder="예: VRRP 상태 비교, ACL 점검">
    </div>
    <div class="form-text">패널 배치·비율, 패널별 접속 프로필, 글자 크기, 웹 GUI 주소가 저장됩니다. 비밀번호는 저장하지 않습니다.</div>
</div>
<div class="modal-footer">
    <button class="btn btn-secondary" (click)="cancel()">취소</button>
    <button class="btn btn-primary" [disabled]="!name.trim()" (click)="ok()">저장</button>
</div>
`,
})
export class HagisSaveWorkspaceModalComponent implements OnInit {
    @Input() workspaces: HagisWorkspace[] = []
    @Input() suggestedName = ''

    targetId: string|null = null
    name = ''
    customer = ''
    description = ''
    customers: string[] = []

    constructor (private modal: NgbActiveModal) { }

    ngOnInit (): void {
        this.name = this.suggestedName
        this.customers = [...new Set(this.workspaces.map(x => x.customer).filter(x => !!x) as string[])].sort()
    }

    onTargetChange (): void {
        const ws = this.workspaces.find(x => x.id === this.targetId)
        if (ws) {
            this.name = ws.name
            this.customer = ws.customer ?? ''
            this.description = ws.description ?? ''
        }
    }

    ok (): void {
        if (!this.name.trim()) {
            return
        }
        const result: HagisSaveWorkspaceResult = {
            id: this.targetId ?? undefined,
            name: this.name.trim(),
            customer: this.customer.trim() || undefined,
            description: this.description.trim() || undefined,
        }
        this.modal.close(result)
    }

    cancel (): void {
        this.modal.dismiss()
    }
}
