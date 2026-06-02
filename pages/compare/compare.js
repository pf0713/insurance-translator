const { API } = require('../../utils/config');

Page({
  data: {
    inputMode: 'text',
    policyText: '',
    imagePath: '',
    fileContent: '',
    fileName: '',
    canStart: false,
    chatStarted: false,
    messages: [],
    question: '',
    isThinking: false,
  },

  _updateCanStart() {
    const ok = this.data.policyText.trim() || this.data.imagePath || this.data.fileContent;
    this.setData({ canStart: !!ok });
  },

  goTranslate() { wx.navigateTo({ url: '/pages/index/index' }); },
  goQuote() { wx.navigateTo({ url: '/pages/quote/quote' }); },

  setInputMode(e) { this.setData({ inputMode: e.currentTarget.dataset.mode }); },

  onPolicyInput(e) {
    this.setData({ policyText: e.detail.value });
    this._updateCanStart();
  },

  onChooseImage() {
    wx.chooseImage({
      count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (res) => {
        this.setData({ imagePath: res.tempFilePaths[0], policyText: '', fileContent: '', fileName: '' });
        this._updateCanStart();
      }
    });
  },

  onChooseFile() {
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
                    this.setData({ fileContent: resp.data.result, fileName: file.name, policyText: '', imagePath: '' });
                    this._updateCanStart();
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
            content: '请用手机截图后点「📷 拍照」上传图片，或复制文件内容粘贴到输入框。',
            showCancel: false
          });
          return;
        }
        wx.showLoading({ title: '读取文件中...' });
        const fs = wx.getFileSystemManager();
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
            this.setData({ fileContent: r.data, fileName: file.name, policyText: '', imagePath: '' });
            this._updateCanStart();
          },
          fail: (err) => {
            wx.hideLoading();
            wx.showModal({
              title: '文件读取失败',
              content: '可能原因：文件过大、格式不支持、或文件权限受限。请尝试复制内容粘贴到输入框。错误：' + (err.errMsg || '未知'),
              showCancel: false
            });
          }
        });
      },
      fail: () => {}
    });
  },

  // ── 开始解读 ──
  async onStartChat() {
    let policyContent = '';

    if (this.data.inputMode === 'text') {
      policyContent = this.data.policyText.trim();
    } else if (this.data.inputMode === 'image' && this.data.imagePath) {
      this.setData({ isThinking: true, chatStarted: true, messages: [] });
      const fs = wx.getFileSystemManager();
      try {
        const base64 = await new Promise((resolve, reject) => {
          fs.readFile({ filePath: this.data.imagePath, encoding: 'base64', success: r => resolve(r.data), fail: reject });
        });
        const resp = await new Promise((resolve, reject) => {
          wx.request({
            url: API + '/api/ai/analyze-image', method: 'POST',
            data: { imageBase64: base64 },
            success: resolve, fail: reject
          });
        });
        if (resp.data.error) {
          this.setData({ isThinking: false, chatStarted: false });
          wx.showToast({ title: resp.data.error, icon: 'none' });
          return;
        }
        policyContent = resp.data.result;
      } catch (e) {
        this.setData({ isThinking: false, chatStarted: false });
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
        return;
      }
    } else if (this.data.inputMode === 'file' && this.data.fileContent) {
      policyContent = this.data.fileContent.trim();
    }

    if (!policyContent) {
      wx.showToast({ title: '请输入保单内容', icon: 'none' });
      return;
    }

    this._policyContent = policyContent;
    this.setData({ chatStarted: true, isThinking: true, messages: [] });

    this._sendMessage('请帮我解读这份保单，用大白话说明：保什么、不保什么、有什么需要注意的地方');
  },

  // ── 发送消息 ──
  _sendMessage(content) {
    const userMsg = { role: 'user', content };
    const msgs = [...this.data.messages, userMsg];
    this.setData({ messages: msgs, isThinking: true, question: '' });

    // 用本地 msgs 构建历史（排除最新这条用户消息）
    const history = msgs.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

    wx.request({
      url: API + '/api/ai/chat', method: 'POST',
      data: { policyText: this._policyContent, message: content, history },
      success: (resp) => {
        if (resp.data.error) {
          wx.showToast({ title: resp.data.error, icon: 'none' });
          this.setData({ isThinking: false });
        } else {
          const newMsgs = [...msgs, { role: 'expert', content: resp.data.reply }];
          this.setData({ messages: newMsgs, isThinking: false });
        }
      },
      fail: () => {
        wx.showToast({ title: '连接失败，请确认后端已启动', icon: 'none' });
        this.setData({ isThinking: false });
      }
    });
  },

  onQuestionInput(e) { this.setData({ question: e.detail.value }); },

  onAsk() {
    const q = this.data.question.trim();
    if (!q || this.data.isThinking) return;
    this._sendMessage(q);
  },
});
