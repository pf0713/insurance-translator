const { API } = require('../../utils/config');
let nextId = 0;

function makePolicy(label) {
  return { id: ++nextId, label, mode: 'text', text: '', imagePath: '', fileContent: '', fileName: '', company: '', premium: '' };
}

Page({
  data: {
    policies: [makePolicy('A'), makePolicy('B')],
    isLoading: false,
    hasResult: false,
    compareResult: '',
    canCompare: false,
  },

  _updateCanCompare() {
    const ok = this.data.policies.filter(p => (p.text.trim() || p.imagePath || p.fileContent) && p.company.trim());
    this.setData({ canCompare: ok.length >= 2 });
  },

  goTranslate() { wx.navigateTo({ url: '/pages/index/index' }); },
  goCompare() { wx.navigateTo({ url: '/pages/compare/compare' }); },

  addPolicy() {
    const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const idx = this.data.policies.length;
    const label = idx < 26 ? labels[idx] : String(idx + 1);
    this.data.policies.push(makePolicy(label));
    this.setData({ policies: this.data.policies });
    this._updateCanCompare();
  },

  removePolicy(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.policies.length <= 2) {
      wx.showToast({ title: '至少保留2个报价', icon: 'none' });
      return;
    }
    const policies = this.data.policies.filter(p => p.id !== id);
    const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    policies.forEach((p, i) => { p.label = i < 26 ? labels[i] : String(i + 1); });
    this.setData({ policies });
    this._updateCanCompare();
  },

  switchMode(e) {
    const { id, mode } = e.currentTarget.dataset;
    const idx = this.data.policies.findIndex(p => p.id === id);
    if (idx !== -1) this.setData({ [`policies[${idx}].mode`]: mode });
  },

  onCompanyInput(e) {
    const { id } = e.currentTarget.dataset;
    const idx = this.data.policies.findIndex(p => p.id === id);
    if (idx !== -1) {
      this.setData({ [`policies[${idx}].company`]: e.detail.value });
      this._updateCanCompare();
    }
  },

  onPremiumInput(e) {
    const { id } = e.currentTarget.dataset;
    const idx = this.data.policies.findIndex(p => p.id === id);
    if (idx !== -1) this.setData({ [`policies[${idx}].premium`]: e.detail.value });
  },

  onTextInput(e) {
    const { id } = e.currentTarget.dataset;
    const idx = this.data.policies.findIndex(p => p.id === id);
    if (idx !== -1) {
      this.setData({ [`policies[${idx}].text`]: e.detail.value });
      this._updateCanCompare();
    }
  },

  onImage(e) {
    const { id } = e.currentTarget.dataset;
    const idx = this.data.policies.findIndex(p => p.id === id);
    if (idx === -1) return;
    wx.chooseImage({
      count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (res) => {
        this.setData({ [`policies[${idx}].imagePath`]: res.tempFilePaths[0], [`policies[${idx}].text`]: '', [`policies[${idx}].fileContent`]: '' });
        this._updateCanCompare();
      }
    });
  },

  onFile(e) {
    const { id } = e.currentTarget.dataset;
    const idx = this.data.policies.findIndex(p => p.id === id);
    if (idx === -1) return;
    wx.chooseMessageFile({
      count: 1, type: 'file',
      success: (res) => {
        const file = res.tempFiles[0];
        const ext = (file.name || '').split('.').pop()?.toLowerCase();
        if (ext === 'pdf') {
          wx.showLoading({ title: '解析PDF中...' });
          fs.readFile({
            filePath: file.path, encoding: 'base64',
            success: (r) => {
              wx.request({
                url: API + '/api/ai/analyze-pdf', method: 'POST',
                data: { fileBase64: r.data, fileName: file.name },
                success: (resp) => {
                  wx.hideLoading();
                  if (resp.data.error) {
                    wx.showToast({ title: resp.data.error, icon: 'none' });
                  } else {
                    this.setData({ [`policies[${idx}].fileContent`]: resp.data.result, [`policies[${idx}].fileName`]: file.name, [`policies[${idx}].text`]: '', [`policies[${idx}].imagePath`]: '' });
                    this._updateCanCompare();
                  }
                },
                fail: () => { wx.hideLoading(); wx.showToast({ title: '连接失败', icon: 'none' }); }
              });
            },
            fail: () => { wx.hideLoading(); wx.showToast({ title: 'PDF读取失败', icon: 'none' }); }
          });
          return;
        }
        if (['doc','docx','xls','xlsx','ppt','pptx'].includes(ext)) {
          wx.showModal({
            title: ext.toUpperCase() + ' 文件不支持直接读取',
            content: '请用手机截图后点「📷 拍照」上传，或复制内容粘贴到输入框。',
            showCancel: false
          });
          return;
        }
        const fs = wx.getFileSystemManager();
        wx.showLoading({ title: '读取文件中...' });
        fs.readFile({
          filePath: file.path, encoding: 'utf8',
          success: (r) => {
            wx.hideLoading();
            if (!r.data || !r.data.trim()) {
              wx.showToast({ title: '文件为空或无法识别内容', icon: 'none' });
              return;
            }
            const sample = r.data.slice(0, 200);
            const garbled = (sample.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
            if (garbled > sample.length * 0.1) {
              wx.showModal({
                title: '文件格式不支持',
                content: '检测到该文件可能是二进制格式。请用手机截图后点「📷 拍照」，或复制内容粘贴到输入框。',
                showCancel: false
              });
              return;
            }
            this.setData({ [`policies[${idx}].fileContent`]: r.data, [`policies[${idx}].fileName`]: file.name, [`policies[${idx}].text`]: '', [`policies[${idx}].imagePath`]: '' });
            this._updateCanCompare();
          },
          fail: (err) => {
            wx.hideLoading();
            wx.showModal({
              title: '文件读取失败',
              content: '请尝试复制内容粘贴到输入框。错误：' + (err.errMsg || '未知'),
              showCancel: false
            });
          }
        });
      },
      fail: () => {}
    });
  },

  _getContent(policy) {
    if (policy.mode === 'text') return Promise.resolve(policy.text.trim());
    if (policy.mode === 'image' && policy.imagePath) {
      return new Promise((resolve, reject) => {
        const fs = wx.getFileSystemManager();
        fs.readFile({
          filePath: policy.imagePath, encoding: 'base64',
          success: (r) => {
            wx.request({
              url: API + '/api/ai/analyze-image', method: 'POST',
              data: { imageBase64: r.data },
              success: (resp) => {
                resolve(resp.data.result || resp.data.error || '图片识别失败');
              },
              fail: () => resolve('图片上传失败，请用文字输入')
            });
          },
          fail: () => resolve('图片读取失败，请用文字输入')
        });
      });
    }
    if (policy.mode === 'file' && policy.fileContent) return Promise.resolve(policy.fileContent.trim());
    return Promise.resolve(null);
  },

  async onCompare() {
    const policies = [];
    for (const p of this.data.policies) {
      const content = await this._getContent(p);
      if (content && p.company.trim()) {
        policies.push({ clause: content, company: p.company.trim(), premium: p.premium || '', label: p.label });
      }
    }
    if (policies.length < 2) return wx.showToast({ title: '至少填写2家公司的报价', icon: 'none' });

    this.setData({ isLoading: true, hasResult: false });

    wx.request({
      url: API + '/api/ai/quote-compare', method: 'POST',
      data: { policies },
      success: (resp) => {
        if (resp.data.error) {
          wx.showToast({ title: resp.data.error, icon: 'none' });
          this.setData({ isLoading: false });
        } else {
          this.setData({ isLoading: false, hasResult: true, compareResult: resp.data.result });
        }
      },
      fail: () => {
        wx.showToast({ title: '连接失败，请确认后端已启动', icon: 'none' });
        this.setData({ isLoading: false });
      }
    });
  },
});
